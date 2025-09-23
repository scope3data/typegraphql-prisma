import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

import type { DMMF as PrismaDMMF } from "@prisma/generator-helper";
import { Project, ScriptTarget, ModuleKind, type CompilerOptions } from "ts-morph";

import { noop, toUnixPath } from "./helpers";
import generateEnumFromDef from "./enum";
import generateObjectTypeClassFromModel from "./model-type-class";
import generateRelationsResolverClassesFromModel from "./resolvers/relations";
import {
  generateOutputTypeClassFromType,
  generateInputTypeClassFromType,
} from "./type-class";
import generateCrudResolverClassFromMapping from "./resolvers/full-crud";
import {
  resolversFolderName,
  relationsResolversFolderName,
  crudResolversFolderName,
  inputsFolderName,
  outputsFolderName,
  enumsFolderName,
  modelsFolderName,
  argsFolderName,
} from "./config";
import {
  generateResolversBarrelFile,
  generateInputsBarrelFile,
  generateOutputsBarrelFile,
  generateIndexFile,
  generateModelsBarrelFile,
  generateEnumsBarrelFile,
  generateArgsBarrelFile,
  generateArgsIndexFile,
  generateResolversIndexFile,
  generateResolversActionsBarrelFile,
} from "./imports";
import type {
  InternalGeneratorOptions,
  ExternalGeneratorOptions,
  GeneratorOptions,
} from "./options";
import { DmmfDocument } from "./dmmf/dmmf-document";
import generateArgsTypeClassFromArgs from "./args-class";
import generateActionResolverClass from "./resolvers/separate-action";
import { ensureInstalledCorrectPrismaPackage } from "../utils/prisma-version";
import type { GenerateMappingData } from "./types";
import { generateEnhanceMap } from "./generate-enhance";
import { generateCustomScalars } from "./generate-scalars";
import { generateHelpersFile } from "./generate-helpers";
import type { DMMF } from "./dmmf/types";
import { getBlocksToEmit } from "./emit-block";
import type { MetricsListener } from "./metrics";

const execa = promisify(exec);

const baseCompilerOptions: CompilerOptions = {
  target: ScriptTarget.ES2021,
  module: ModuleKind.CommonJS,
  emitDecoratorMetadata: true,
  experimentalDecorators: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

class CodeGenerator {
  constructor(private metrics?: MetricsListener) {}

  async generate(
    dmmf: PrismaDMMF.Document,
    baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
    log: (msg: string) => void = noop,
  ): Promise<void> {
    const startTime = performance.now();
    ensureInstalledCorrectPrismaPackage();

    const options: GeneratorOptions = Object.assign({}, baseOptions, {
      blocksToEmit: getBlocksToEmit(baseOptions.emitOnly),
      contextPrismaKey: baseOptions.contextPrismaKey ?? "prisma",
      relativePrismaOutputPath: toUnixPath(
        path.relative(baseOptions.outputDirPath, baseOptions.prismaClientPath),
      ),
      absolutePrismaOutputPath:
        !baseOptions.customPrismaImportPath &&
        baseOptions.prismaClientPath.includes("node_modules")
          ? "@prisma/client"
          : undefined,
      formatGeneratedCode: baseOptions.formatGeneratedCode ?? false,
    });

    const baseDirPath = options.outputDirPath;
    const emitTranspiledCode =
      options.emitTranspiledCode ??
      options.outputDirPath.includes("node_modules");

    const project = new Project({
      compilerOptions: Object.assign({}, baseCompilerOptions, emitTranspiledCode ? {
        declaration: true,
        importHelpers: true,
      } : {}),
    });

    log("Transforming dmmfDocument...");
    const dmmfStart = performance.now();
    const dmmfDocument = new DmmfDocument(dmmf, options);
    this.metrics?.emitMetric('dmmf-document-creation', performance.now() - dmmfStart);

    // Generate enums
    if (dmmfDocument.shouldGenerateBlock("enums")) {
      log("Generating enums...");
      const enumStart = performance.now();
      const allEnums = dmmfDocument.datamodel.enums.concat(
        dmmfDocument.schema.enums.filter(enumDef =>
          !dmmfDocument.datamodel.enums.map(e => e.typeName).includes(enumDef.typeName)
        )
      );

      allEnums.forEach((enumDef) => {
        generateEnumFromDef(project, baseDirPath, enumDef);
      });

      this.metrics?.emitMetric('enum-generation', performance.now() - enumStart, allEnums.length);

      const emittedEnumNames = Array.from(new Set(
        dmmfDocument.schema.enums.map(it => it.typeName)
          .concat(dmmfDocument.datamodel.enums.map(it => it.typeName))
      ));

      const enumsBarrelExportSourceFile = project.createSourceFile(
        path.resolve(baseDirPath, enumsFolderName, "index.ts"),
        undefined,
        { overwrite: true },
      );
      generateEnumsBarrelFile(enumsBarrelExportSourceFile, emittedEnumNames);
    }

    // Generate models
    if (dmmfDocument.shouldGenerateBlock("models")) {
      log("Generating models...");
      const modelStart = performance.now();
      dmmfDocument.datamodel.models.forEach(model => {
        const modelOutputType = dmmfDocument.outputTypeCache.get(model.name);

        if (!modelOutputType) {
          throw new Error(`Model ${model.name} has no output type. This indicates a problem with the DMMF document processing.`);
        }

        generateObjectTypeClassFromModel(
          project,
          baseDirPath,
          model,
          modelOutputType,
          dmmfDocument,
        );
      });

      this.metrics?.emitMetric('model-generation', performance.now() - modelStart, dmmfDocument.datamodel.models.length);

      const modelsBarrelExportSourceFile = project.createSourceFile(
        path.resolve(baseDirPath, modelsFolderName, "index.ts"),
        undefined,
        { overwrite: true },
      );
      generateModelsBarrelFile(
        modelsBarrelExportSourceFile,
        dmmfDocument.datamodel.models.map(it => it.typeName),
      );
    }

    const resolversDirPath = path.resolve(baseDirPath, resolversFolderName);
    let outputTypesToGenerate: DMMF.OutputType[] = [];

    // Generate output types
    if (dmmfDocument.shouldGenerateBlock("outputs")) {
      log("Generating output types...");
      const outputStart = performance.now();
      const rootTypes = dmmfDocument.schema.outputTypes.filter(type =>
        ["Query", "Mutation"].includes(type.name),
      );
      const modelNames = dmmfDocument.datamodel.models.map(model => model.name);
      outputTypesToGenerate = dmmfDocument.schema.outputTypes.filter(
        type => !modelNames.includes(type.name) && !rootTypes.includes(type),
      );

      const outputTypesFieldsArgsToGenerate = outputTypesToGenerate
        .map(it => it.fields)
        .reduce((a, b) => a.concat(b), [])
        .filter(it => it.argsTypeName);

      outputTypesToGenerate.forEach((type) => {
        generateOutputTypeClassFromType(
          project,
          resolversDirPath,
          type,
          dmmfDocument,
        );
      });

      this.metrics?.emitMetric('output-type-generation', performance.now() - outputStart, outputTypesToGenerate.length);

      if (outputTypesFieldsArgsToGenerate.length > 0) {
        log("Generating output types args...");
        outputTypesFieldsArgsToGenerate.forEach((field) => {
          if (!field.argsTypeName) {
            throw new Error(`Expected argsTypeName to be defined for field after filtering, but got ${field.argsTypeName}`);
          }
          generateArgsTypeClassFromArgs(
            project,
            path.resolve(resolversDirPath, outputsFolderName),
            field.args,
            field.argsTypeName,
            dmmfDocument,
            2,
          );
        });

        const outputsArgsBarrelExportSourceFile = project.createSourceFile(
          path.resolve(
            baseDirPath,
            resolversFolderName,
            outputsFolderName,
            argsFolderName,
            "index.ts",
          ),
          undefined,
          { overwrite: true },
        );
        generateArgsBarrelFile(
          outputsArgsBarrelExportSourceFile,
          outputTypesFieldsArgsToGenerate.map(it => {
            if (!it.argsTypeName) {
              throw new Error(`Expected argsTypeName to be defined after filtering, but got ${it.argsTypeName}`);
            }
            return it.argsTypeName;
          }),
        );
      }

      const outputsBarrelExportSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          outputsFolderName,
          "index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateOutputsBarrelFile(
        outputsBarrelExportSourceFile,
        outputTypesToGenerate.map(it => it.typeName),
        outputTypesToGenerate.some(type =>
          type.fields.some(field => field.argsTypeName)
        ),
      );
    }

    // Generate input types
    if (dmmfDocument.shouldGenerateBlock("inputs")) {
      log("Generating input types...");
      const inputStart = performance.now();
      const allInputTypes: string[] = []
      dmmfDocument.schema.inputTypes.forEach((type) => {
        allInputTypes.push(type.typeName)
        generateInputTypeClassFromType(project, resolversDirPath, type, options);
      });

      this.metrics?.emitMetric('input-type-generation', performance.now() - inputStart, dmmfDocument.schema.inputTypes.length);

      const inputsBarrelExportSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          inputsFolderName,
          "index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateInputsBarrelFile(
        inputsBarrelExportSourceFile,
        allInputTypes
      );
    }

    // Generate relation resolvers
    if (
      dmmfDocument.relationModels.length > 0 &&
      dmmfDocument.shouldGenerateBlock("relationResolvers")
    ) {
      log("Generating relation resolvers...");
      const relationResolverStart = performance.now();
      dmmfDocument.relationModels.forEach(relationModel => {
        generateRelationsResolverClassesFromModel(
          project,
          baseDirPath,
          dmmfDocument,
          relationModel,
          options,
        );
      });

      const relationResolversBarrelExportSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          relationsResolversFolderName,
          "resolvers.index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateResolversBarrelFile(
        relationResolversBarrelExportSourceFile,
        dmmfDocument.relationModels.map<GenerateMappingData>(relationModel => ({
          resolverName: relationModel.resolverName,
          modelName: relationModel.model.typeName,
        })),
      );

      this.metrics?.emitMetric('relation-resolver-generation', performance.now() - relationResolverStart, dmmfDocument.relationModels.length);

      log("Generating relation resolver args...");
      const relationArgsStart = performance.now();
      dmmfDocument.relationModels.forEach(relationModelData => {
        const resolverDirPath = path.resolve(
          baseDirPath,
          resolversFolderName,
          relationsResolversFolderName,
          relationModelData.model.typeName,
        );

        const fieldsWithArgs = relationModelData.relationFields.filter(field => field.argsTypeName);

        fieldsWithArgs.forEach((field) => {
          if (!field.argsTypeName) {
            throw new Error(`Expected argsTypeName to be defined for relation field after filtering, but got ${field.argsTypeName}`);
          }
          generateArgsTypeClassFromArgs(
            project,
            resolverDirPath,
            field.outputTypeField.args,
            field.argsTypeName,
            dmmfDocument,
          );
        });

        const argTypeNames = relationModelData.relationFields
          .filter(it => it.argsTypeName !== undefined)
          .map(it => {
            if (!it.argsTypeName) {
              throw new Error(`Expected argsTypeName to be defined after filtering, but got ${it.argsTypeName}`);
            }
            return it.argsTypeName;
          });

        if (argTypeNames.length) {
          const barrelExportSourceFile = project.createSourceFile(
            path.resolve(resolverDirPath, argsFolderName, "index.ts"),
            undefined,
            { overwrite: true },
          );
          generateArgsBarrelFile(barrelExportSourceFile, argTypeNames);
        }
      });

      // Generate remaining relation resolver index files
      const relationModelsWithArgs = dmmfDocument.relationModels.filter(
        relationModelData =>
          relationModelData.relationFields.some(
            it => it.argsTypeName !== undefined,
          ),
      );

      if (relationModelsWithArgs.length > 0) {
        const relationResolversArgsIndexSourceFile = project.createSourceFile(
          path.resolve(
            baseDirPath,
            resolversFolderName,
            relationsResolversFolderName,
            "args.index.ts",
          ),
          undefined,
          { overwrite: true },
        );
        generateArgsIndexFile(
          relationResolversArgsIndexSourceFile,
          relationModelsWithArgs.map(
            relationModelData => relationModelData.model.typeName,
          ),
        );
      }

      const relationResolversIndexSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          relationsResolversFolderName,
          "index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateResolversIndexFile(
        relationResolversIndexSourceFile,
        "relations",
        relationModelsWithArgs.length > 0,
      );

      this.metrics?.emitMetric('relation-resolver-args', performance.now() - relationArgsStart);
    }

    // Generate CRUD resolvers
    if (dmmfDocument.shouldGenerateBlock("crudResolvers")) {
      log("Generating crud resolvers...");
      const crudResolverStart = performance.now();
      dmmfDocument.modelMappings.forEach(mapping => {
        // Use cached model lookup instead of find()
        const model = dmmfDocument.modelsCache.get(mapping.modelName);
        if (!model) {
          throw new Error(`No model found for mapping ${mapping.modelName}. This indicates a problem with the DMMF document processing.`);
        }

        generateCrudResolverClassFromMapping(
          project,
          baseDirPath,
          mapping,
          model,
          dmmfDocument,
          options,
        );

        mapping.actions.forEach((action) => {
          generateActionResolverClass(
            project,
            baseDirPath,
            model,
            action,
            mapping,
            dmmfDocument,
            options,
          );
        });
      });

      // Generate CRUD resolver barrel files
      const generateMappingData = dmmfDocument.modelMappings
        .map(mapping => {
          const model = dmmfDocument.modelsCache.get(mapping.modelName);
          if (!model) {
            throw new Error(`No model found for mapping ${mapping.modelName} when generating mapping data. This indicates a problem with the DMMF document processing.`);
          }
          return {
            modelName: model.typeName,
            resolverName: mapping.resolverName,
            actionResolverNames: mapping.actions.map(it => it.actionResolverName),
          } as GenerateMappingData;
        })
        .filter((item: GenerateMappingData | null): item is GenerateMappingData => item !== null);

      const crudResolversBarrelExportSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          crudResolversFolderName,
          "resolvers-crud.index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateResolversBarrelFile(
        crudResolversBarrelExportSourceFile,
        generateMappingData,
      );

      const crudResolversActionsBarrelExportSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          crudResolversFolderName,
          "resolvers-actions.index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateResolversActionsBarrelFile(
        crudResolversActionsBarrelExportSourceFile,
        generateMappingData,
      );

      const crudResolversIndexSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          crudResolversFolderName,
          "index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateResolversIndexFile(crudResolversIndexSourceFile, "crud", true);

      this.metrics?.emitMetric('crud-resolver-generation', performance.now() - crudResolverStart, dmmfDocument.modelMappings.length);

      log("Generating crud resolvers args...");
      const crudArgsStart = performance.now();
      dmmfDocument.modelMappings.forEach(mapping => {
        const actionsWithArgs = mapping.actions.filter(
          it => it.argsTypeName !== undefined,
        );

        if (actionsWithArgs.length) {
          const model = dmmfDocument.modelsCache.get(mapping.modelName);
          if (!model) {
            throw new Error(`No model found for mapping ${mapping.modelName} when generating CRUD resolver args. This indicates a problem with the DMMF document processing.`);
          }
          const resolverDirPath = path.resolve(
            baseDirPath,
            resolversFolderName,
            crudResolversFolderName,
            model.typeName,
          );

          actionsWithArgs.forEach((action) => {
            if (!action.argsTypeName) {
              throw new Error(`Expected argsTypeName to be defined for CRUD action after filtering, but got ${action.argsTypeName}`);
            }
            generateArgsTypeClassFromArgs(
              project,
              resolverDirPath,
              action.method.args,
              action.argsTypeName,
              dmmfDocument,
            );
          });

          const barrelExportSourceFile = project.createSourceFile(
            path.resolve(resolverDirPath, argsFolderName, "index.ts"),
            undefined,
            { overwrite: true },
          );
          generateArgsBarrelFile(
            barrelExportSourceFile,
            actionsWithArgs.map(it => {
              if (!it.argsTypeName) {
                throw new Error(`Expected argsTypeName to be defined for CRUD action after filtering, but got ${it.argsTypeName}`);
              }
              return it.argsTypeName;
            }),
          );
        }
      });

      const crudResolversArgsIndexSourceFile = project.createSourceFile(
        path.resolve(
          baseDirPath,
          resolversFolderName,
          crudResolversFolderName,
          "args.index.ts",
        ),
        undefined,
        { overwrite: true },
      );
      generateArgsIndexFile(
        crudResolversArgsIndexSourceFile,
        dmmfDocument.modelMappings
          .filter(mapping =>
            mapping.actions.some(it => it.argsTypeName !== undefined),
          )
          .map(mapping => mapping.modelTypeName),
      );

      this.metrics?.emitMetric('crud-resolver-args', performance.now() - crudArgsStart);
    }

    // Generate auxiliary files
    log("Generate auxiliary files");
    const auxiliaryStart = performance.now();
    const enhanceSourceFile = project.createSourceFile(
      baseDirPath + "/enhance.ts",
      undefined,
      { overwrite: true },
    );
    generateEnhanceMap(
      enhanceSourceFile,
      dmmfDocument,
      dmmfDocument.modelMappings,
      dmmfDocument.relationModels,
      dmmfDocument.datamodel.models,
      dmmfDocument.schema.inputTypes,
      outputTypesToGenerate,
    );

    const scalarsSourceFile = project.createSourceFile(
      baseDirPath + "/scalars.ts",
      undefined,
      { overwrite: true },
    );
    generateCustomScalars(scalarsSourceFile, dmmfDocument.options);

    const helpersSourceFile = project.createSourceFile(
      baseDirPath + "/helpers.ts",
      undefined,
      { overwrite: true },
    );
    generateHelpersFile(helpersSourceFile, dmmfDocument.options);

    const indexSourceFile = project.createSourceFile(
      baseDirPath + "/index.ts",
      undefined,
      { overwrite: true },
    );
    generateIndexFile(
      indexSourceFile,
      dmmfDocument.relationModels.length > 0,
      dmmfDocument.options.blocksToEmit,
    );

    this.metrics?.emitMetric('auxiliary-files', performance.now() - auxiliaryStart);

    // Emit generated code files
    log("Emitting generated code files");
    const emitStart = performance.now();
    if (emitTranspiledCode) {
      await project.emit();
    } else {
      if (options.formatGeneratedCode === "tsc") {
        const tscFormatStart = performance.now();
        const sourceFiles = project.getSourceFiles();
        sourceFiles.forEach((file) => {
          file.formatText({ indentSize: 2 });
        });
        this.metrics?.emitMetric('tsc-formatting', performance.now() - tscFormatStart, sourceFiles.length);
      }

      const saveStart = performance.now();
      await project.save();
      this.metrics?.emitMetric('file-writing', performance.now() - saveStart);

      if (options.formatGeneratedCode === "prettier") {
        const prettierStart = performance.now();
        await execa(`npx prettier --write --ignore-path .prettierignore ${baseDirPath}`);
        this.metrics?.emitMetric('prettier-formatting', performance.now() - prettierStart);
      }
    }

    this.metrics?.emitMetric('code-emission', performance.now() - emitStart);
    this.metrics?.emitMetric('total-generation', performance.now() - startTime);
    this.metrics?.onComplete?.();
  }
}

export default async function generateCode(
  dmmf: PrismaDMMF.Document,
  baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
  log: (msg: string) => void = noop,
  metrics?: MetricsListener,
): Promise<void> {
  const generator = new CodeGenerator(metrics);
  return generator.generate(dmmf, baseOptions, log);
}

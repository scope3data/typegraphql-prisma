import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

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

  async generate(
    dmmf: PrismaDMMF.Document,
    baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
    log: (msg: string) => void = noop,
  ): Promise<void> {
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
      formatGeneratedCode: baseOptions.formatGeneratedCode ?? "tsc",
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
    const dmmfDocument = new DmmfDocument(dmmf, options);

    // Generate enums
    if (dmmfDocument.shouldGenerateBlock("enums")) {
      log("Generating enums...");
      const allEnums = dmmfDocument.datamodel.enums.concat(
        dmmfDocument.schema.enums.filter(enumDef =>
          !dmmfDocument.datamodel.enums.map(e => e.typeName).includes(enumDef.typeName)
        )
      );

      allEnums.forEach((enumDef) => {
        generateEnumFromDef(project, baseDirPath, enumDef);
      });

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
      dmmfDocument.schema.inputTypes.forEach((type) => {
        generateInputTypeClassFromType(project, resolversDirPath, type, options);
      });

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
        dmmfDocument.schema.inputTypes.map(it => it.typeName),
      );
    }

    // Generate relation resolvers
    if (
      dmmfDocument.relationModels.length > 0 &&
      dmmfDocument.shouldGenerateBlock("relationResolvers")
    ) {
      log("Generating relation resolvers...");
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

      log("Generating relation resolver args...");
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
    }

    // Generate CRUD resolvers
    if (dmmfDocument.shouldGenerateBlock("crudResolvers")) {
      log("Generating crud resolvers...");
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

      log("Generating crud resolvers args...");
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
    }

    // Generate auxiliary files
    log("Generate auxiliary files");
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

    // Emit generated code files
    log("Emitting generated code files");
    if (emitTranspiledCode) {
      await project.emit();
    } else {
      if (options.formatGeneratedCode === "tsc") {
        const sourceFiles = project.getSourceFiles();
        sourceFiles.forEach((file) => {
          file.formatText({ indentSize: 2 });
        });
      }

      await project.save();

      if (options.formatGeneratedCode === "prettier") {
        await execa(`npx prettier --write --ignore-path .prettierignore ${baseDirPath}`);
      }
    }

  }
}

export default async function generateCode(
  dmmf: PrismaDMMF.Document,
  baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
  log: (msg: string) => void = noop,
): Promise<void> {
  const generator = new CodeGenerator();
  return generator.generate(dmmf, baseOptions, log);
}

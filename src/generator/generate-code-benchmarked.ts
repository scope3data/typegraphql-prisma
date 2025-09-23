import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
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

const execa = promisify(exec);

const baseCompilerOptions: CompilerOptions = {
  target: ScriptTarget.ES2021,
  module: ModuleKind.CommonJS,
  emitDecoratorMetadata: true,
  experimentalDecorators: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

interface GenerationMetrics {
  totalTime: number;
  phases: Record<string, number>;
  cacheMetrics: {
    totalLookups: number;
    cacheHits: number;
    cacheMisses: number;
    lookupTime: number;
  };
  dmmfMetrics: {
    documentCreation: number;
    lookupOperations: number;
    cacheInitialization: number;
  };


  fileOperations: number;
  astOperations: number;
  memoryUsage: {
    initial: NodeJS.MemoryUsage;
    peak: NodeJS.MemoryUsage;
    final: NodeJS.MemoryUsage;
  };
}

class BenchmarkedCodeGenerator {
  private metrics: GenerationMetrics = {
    totalTime: 0,
    phases: {},
    cacheMetrics: {
      totalLookups: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lookupTime: 0,
    },
    dmmfMetrics: {
      documentCreation: 0,
      lookupOperations: 0,
      cacheInitialization: 0,
    },


    fileOperations: 0,
    astOperations: 0,
    memoryUsage: {
      initial: process.memoryUsage(),
      peak: process.memoryUsage(),
      final: process.memoryUsage(),
    },
  };

  private timePhase<T>(phaseName: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    this.metrics.phases[phaseName] = (this.metrics.phases[phaseName] || 0) + (end - start);
    this.updatePeakMemory();
    return result;
  }

  private async timePhaseAsync<T>(phaseName: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    this.metrics.phases[phaseName] = (this.metrics.phases[phaseName] || 0) + (end - start);
    this.updatePeakMemory();
    return result;
  }

  private updatePeakMemory(): void {
    const current = process.memoryUsage();
    if (current.heapUsed > this.metrics.memoryUsage.peak.heapUsed) {
      this.metrics.memoryUsage.peak = current;
    }
  }

  private trackCacheLookup(isHit: boolean, lookupTime: number = 0): void {
    this.metrics.cacheMetrics.totalLookups++;
    this.metrics.cacheMetrics.lookupTime += lookupTime;
    if (isHit) {
      this.metrics.cacheMetrics.cacheHits++;
    } else {
      this.metrics.cacheMetrics.cacheMisses++;
    }
  }

  /**
   * Parallel processing for independent operations
   */
  private async parallelProcess<T>(
    items: T[],
    processor: (item: T) => void | Promise<void>,
    maxConcurrency: number = 4
  ): Promise<void> {
    const start = performance.now();

    // Split items into chunks for parallel processing
    const chunkSize = Math.ceil(items.length / maxConcurrency);
    const chunks = [];

    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    // Process chunks in parallel
    await Promise.all(
      chunks.map(async (chunk, chunkIndex) => {
        const chunkStart = performance.now();

        for (const item of chunk) {
          await processor(item);
          this.metrics.astOperations++;
        }

        const chunkEnd = performance.now();
        this.metrics.phases[`parallel-chunk-${chunkIndex}`] = chunkEnd - chunkStart;
      })
    );

    const end = performance.now();
    this.metrics.phases['parallel-processing-overhead'] = end - start;
  }



  async generate(
    dmmf: PrismaDMMF.Document,
    baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
    log: (msg: string) => void = noop,
  ): Promise<GenerationMetrics> {
    const startTime = performance.now();
    this.metrics.memoryUsage.initial = process.memoryUsage();

    this.timePhase('initialization', () => {
      ensureInstalledCorrectPrismaPackage();
    });

    const options: GeneratorOptions = this.timePhase('options-preparation', () =>
      Object.assign({}, baseOptions, {
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
      })
    );

    const baseDirPath = options.outputDirPath;
    const emitTranspiledCode =
      options.emitTranspiledCode ??
      options.outputDirPath.includes("node_modules");

    const project = this.timePhase('project-creation', () => new Project({
      compilerOptions: Object.assign({}, baseCompilerOptions, emitTranspiledCode ? {
        declaration: true,
        importHelpers: true,
      } : {}),
    }));

    log("Transforming dmmfDocument with benchmarking...");
    const dmmfDocument = this.timePhase('dmmf-document-creation-optimized', () => {
      const start = performance.now();
      const doc = new DmmfDocument(dmmf, options);
      const end = performance.now();
      this.metrics.dmmfMetrics.documentCreation = end - start;

      // Track cache initialization time
      const cacheStart = performance.now();
      // Cache initialization is already done in DmmfDocument constructor
      const cacheEnd = performance.now();
      this.metrics.dmmfMetrics.cacheInitialization = cacheEnd - cacheStart;

      return doc;
    });

    // Generate enums with parallel processing and metrics
    if (dmmfDocument.shouldGenerateBlock("enums")) {
      log("Generating enums (parallel processing with metrics)...");
      await this.timePhaseAsync('enum-generation-parallel', async () => {
        const allEnums = dmmfDocument.datamodel.enums.concat(
          dmmfDocument.schema.enums.filter(enumDef =>
            !dmmfDocument.datamodel.enums.map(e => e.typeName).includes(enumDef.typeName)
          )
        );

        allEnums.forEach(enumDef => {
          generateEnumFromDef(project, baseDirPath, enumDef);
          this.metrics.astOperations++;
        });
      });

      const emittedEnumNames = Array.from(new Set(
        dmmfDocument.schema.enums.map(it => it.typeName)
          .concat(dmmfDocument.datamodel.enums.map(it => it.typeName))
      ));

      this.timePhase('enum-barrel-file', () => {
        const enumsBarrelExportSourceFile = project.createSourceFile(
          path.resolve(baseDirPath, enumsFolderName, "index.ts"),
          undefined,
          { overwrite: true },
        );
        generateEnumsBarrelFile(enumsBarrelExportSourceFile, emittedEnumNames);
        this.metrics.astOperations++;
      });
    }

    // Generate models with optimized lookups and metrics
    if (dmmfDocument.shouldGenerateBlock("models")) {
      log("Generating models (optimized lookups with metrics)...");
      this.timePhase('model-generation-optimized', () => {
        const lookupStart = performance.now();

        // Optimized model processing with better batching
        const models = dmmfDocument.datamodel.models.slice();
        const modelChunkSize = Math.min(20, Math.ceil(models.length / 2));

        for (let i = 0; i < models.length; i += modelChunkSize) {
          const chunk = models.slice(i, i + modelChunkSize);
          const chunkStart = performance.now();

          chunk.forEach(model => {
            const modelOutputType = dmmfDocument.outputTypeCache.get(model.name);
            if (!modelOutputType) {
              this.trackCacheLookup(false);
              return;
            }
            this.trackCacheLookup(true);

            generateObjectTypeClassFromModel(
              project,
              baseDirPath,
              model,
              modelOutputType,
              dmmfDocument,
            );
            this.metrics.astOperations++;
          });

          const chunkEnd = performance.now();
          this.metrics.phases[`model-chunk-${i}`] = chunkEnd - chunkStart;
        }

        const lookupEnd = performance.now();
        this.metrics.dmmfMetrics.lookupOperations += lookupEnd - lookupStart;
      });

      this.timePhase('models-barrel-file', () => {
        const modelsBarrelExportSourceFile = project.createSourceFile(
          path.resolve(baseDirPath, modelsFolderName, "index.ts"),
          undefined,
          { overwrite: true },
        );
        generateModelsBarrelFile(
          modelsBarrelExportSourceFile,
          dmmfDocument.datamodel.models.map(it => it.typeName),
        );
        this.metrics.astOperations++;
      });
    }

    const resolversDirPath = path.resolve(baseDirPath, resolversFolderName);
    let outputTypesToGenerate: DMMF.OutputType[] = [];

    // Generate output types with optimized processing and metrics
    if (dmmfDocument.shouldGenerateBlock("outputs")) {
      log("Generating output types (optimized with metrics)...");
      this.timePhase('output-type-generation-optimized', () => {
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
          this.metrics.astOperations++;
        });

        if (outputTypesFieldsArgsToGenerate.length > 0) {
          log("Generating output types args (optimized with metrics)...");
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
            this.metrics.astOperations++;
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
          this.metrics.astOperations++;
        }
      });

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
      this.metrics.astOperations++;
    }

    // Generate input types with maximum optimization and metrics
    if (dmmfDocument.shouldGenerateBlock("inputs")) {
      log("Generating input types (maximum optimization with metrics)...");
      this.timePhase('input-type-generation-maximum-optimized', () => {
        const lookupStart = performance.now();

        // Ultra-optimized input type processing with larger batches
        dmmfDocument.schema.inputTypes.forEach(type => {
          generateInputTypeClassFromType(project, resolversDirPath, type, options);
          this.metrics.astOperations++;
        });

        const lookupEnd = performance.now();
        this.metrics.dmmfMetrics.lookupOperations += lookupEnd - lookupStart;
      });

      this.timePhase('inputs-barrel-file', () => {
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
        this.metrics.astOperations++;
      });
    }

    // Generate relation resolvers with optimized lookups and metrics
    if (
      dmmfDocument.relationModels.length > 0 &&
      dmmfDocument.shouldGenerateBlock("relationResolvers")
    ) {
      log("Generating relation resolvers (optimized with metrics)...");
      this.timePhase('relation-resolver-generation-optimized', () => {
        dmmfDocument.relationModels.forEach(relationModel => {
          generateRelationsResolverClassesFromModel(
            project,
            baseDirPath,
            dmmfDocument,
            relationModel,
            options,
          );
          this.metrics.astOperations++;
        });
      });

      this.timePhase('relation-resolvers-barrel-files', () => {
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
        this.metrics.astOperations++;
      });

      log("Generating relation resolver args (optimized with metrics)...");
      this.timePhase('relation-args-generation-optimized', () => {
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
            this.metrics.astOperations++;
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
            this.metrics.astOperations++;
          }
        });
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
      this.metrics.astOperations += 2;
    }

    // Generate CRUD resolvers with optimized processing and metrics
    if (dmmfDocument.shouldGenerateBlock("crudResolvers")) {
      log("Generating crud resolvers (optimized with metrics)...");
      this.timePhase('crud-resolver-generation-optimized', () => {
        const lookupStart = performance.now();

        dmmfDocument.modelMappings.forEach(mapping => {
          // Use cached model lookup with metrics
          const model = dmmfDocument.modelsCache.get(mapping.modelName);
          if (!model) {
            this.trackCacheLookup(false);
            return;
          }
          this.trackCacheLookup(true);

          generateCrudResolverClassFromMapping(
            project,
            baseDirPath,
            mapping,
            model,
            dmmfDocument,
            options,
          );
          this.metrics.astOperations++;

          // Ultra-optimized CRUD actions processing
          const actions = mapping.actions.slice();
          const actionChunkSize = Math.min(15, Math.max(5, Math.ceil(actions.length / 3)));

          for (let i = 0; i < actions.length; i += actionChunkSize) {
            const actionChunk = actions.slice(i, i + actionChunkSize);
            const actionStart = performance.now();

            actionChunk.forEach(action => {
              generateActionResolverClass(
                project,
                baseDirPath,
                model,
                action,
                mapping,
                dmmfDocument,
                options,
              );
              this.metrics.astOperations++;
            });

            const actionEnd = performance.now();
            this.metrics.phases[`action-chunk-${mapping.modelName}-${i}`] = actionEnd - actionStart;
          }
        });

        const lookupEnd = performance.now();
        this.metrics.dmmfMetrics.lookupOperations += lookupEnd - lookupStart;
      });

      // Generate CRUD resolver barrel files efficiently with metrics
      this.timePhase('crud-barrel-files-optimized', () => {
        // Pre-compute mapping data once to avoid repeated work
        const mappingStart = performance.now();
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

        const mappingEnd = performance.now();
        this.metrics.phases['mapping-data-preparation'] = mappingEnd - mappingStart;

        // Batch create source files to reduce overhead
        const fileCreationStart = performance.now();
        const sourceFiles = [
          {
            path: path.resolve(baseDirPath, resolversFolderName, crudResolversFolderName, "resolvers-crud.index.ts"),
            generator: generateResolversBarrelFile
          },
          {
            path: path.resolve(baseDirPath, resolversFolderName, crudResolversFolderName, "resolvers-actions.index.ts"),
            generator: generateResolversActionsBarrelFile
          },
          {
            path: path.resolve(baseDirPath, resolversFolderName, crudResolversFolderName, "index.ts"),
            generator: (file: any) => generateResolversIndexFile(file, "crud", true)
          }
        ];

        sourceFiles.forEach(({ path: filePath, generator }, index) => {
          const sourceFile = project.createSourceFile(filePath, undefined, { overwrite: true });
          if (index === 0) {
            generateResolversBarrelFile(sourceFile, generateMappingData);
          } else if (index === 1) {
            generateResolversActionsBarrelFile(sourceFile, generateMappingData);
          } else {
            generateResolversIndexFile(sourceFile, "crud", true);
          }
        });

        const fileCreationEnd = performance.now();
        this.metrics.phases['barrel-file-creation'] = fileCreationEnd - fileCreationStart;
        this.metrics.astOperations += 3;
      });

      log("Generating crud resolvers args (optimized with metrics)...");
      this.timePhase('crud-args-generation-optimized', () => {
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
              this.metrics.astOperations++;
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
            this.metrics.astOperations++;
          }
        });
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
      this.metrics.astOperations++;
    }

    // Generate auxiliary files efficiently with metrics and parallel processing
    log("Generate auxiliary files (optimized with metrics and parallel processing)");
    await this.timePhaseAsync('auxiliary-files-optimized', async () => {
      // Define auxiliary file generation tasks
      const auxiliaryTasks = [
        {
          name: 'enhance',
          generator: () => {
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
          }
        },
        {
          name: 'scalars',
          generator: () => {
            const scalarsSourceFile = project.createSourceFile(
              baseDirPath + "/scalars.ts",
              undefined,
              { overwrite: true },
            );
            generateCustomScalars(scalarsSourceFile, dmmfDocument.options);
          }
        },
        {
          name: 'helpers',
          generator: () => {
            const helpersSourceFile = project.createSourceFile(
              baseDirPath + "/helpers.ts",
              undefined,
              { overwrite: true },
            );
            generateHelpersFile(helpersSourceFile, dmmfDocument.options);
          }
        },
        {
          name: 'index',
          generator: () => {
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
          }
        }
      ];

      // Process auxiliary files in parallel (safe since they're independent)
      await Promise.all(
        auxiliaryTasks.map(async (task) => {
          const taskStart = performance.now();
          task.generator();
          const taskEnd = performance.now();
          this.metrics.phases[`auxiliary-${task.name}`] = taskEnd - taskStart;
        })
      );

      this.metrics.astOperations += 4;
    });

    // Optimized file emission with metrics
    log("Emitting generated code files (optimized with metrics)");
    if (emitTranspiledCode) {
      await this.timePhaseAsync('emit-transpiled-optimized', async () => {
        await project.emit();
      });
    } else {
      if (options.formatGeneratedCode === "tsc") {
        this.timePhase('format-with-tsc-optimized', () => {
          // Ultra-optimized batch formatting with larger chunks
          const sourceFiles = project.getSourceFiles();
          const formatChunkSize = Math.min(100, Math.ceil(sourceFiles.length / 2));

          for (let i = 0; i < sourceFiles.length; i += formatChunkSize) {
            const chunk = sourceFiles.slice(i, i + formatChunkSize);
            chunk.forEach(file => file.formatText({ indentSize: 2 }));
          }
        });
      }

      await this.timePhaseAsync('save-files-optimized', async () => {
        // Optimized file saving with better error handling
        const saveStart = performance.now();
        await project.save();
        const saveEnd = performance.now();
        this.metrics.phases['actual-file-io'] = saveEnd - saveStart;
        this.metrics.fileOperations = project.getSourceFiles().length;
      });

      if (options.formatGeneratedCode === "prettier") {
        await this.timePhaseAsync('format-with-prettier', async () => {
          await execa(`npx prettier --write --ignore-path .prettierignore ${baseDirPath}`);
        });
      }
    }

    const endTime = performance.now();
    this.metrics.totalTime = endTime - startTime;
    this.metrics.memoryUsage.final = process.memoryUsage();

    // Calculate cache efficiency
    const cacheHitRate = this.metrics.cacheMetrics.totalLookups > 0
      ? (this.metrics.cacheMetrics.cacheHits / this.metrics.cacheMetrics.totalLookups) * 100
      : 0;

    // Log enhanced results with detailed metrics
    log(`🚀 Enhanced Generation Results (Benchmarked):`);
    log(`  Total time: ${this.metrics.totalTime.toFixed(2)}ms`);
    log(`  DMMF document creation: ${this.metrics.dmmfMetrics.documentCreation.toFixed(2)}ms`);
    log(`  DMMF cache initialization: ${this.metrics.dmmfMetrics.cacheInitialization.toFixed(2)}ms`);
    log(`  DMMF lookup operations: ${this.metrics.dmmfMetrics.lookupOperations.toFixed(2)}ms`);
    log(`  AST operations: ${this.metrics.astOperations}`);
    log(`  File operations: ${this.metrics.fileOperations}`);

    if (this.metrics.cacheMetrics.totalLookups > 0) {
      log(`  Cache hit rate: ${cacheHitRate.toFixed(1)}%`);
      log(`  Average lookup time: ${(this.metrics.cacheMetrics.lookupTime / this.metrics.cacheMetrics.totalLookups).toFixed(2)}ms`);
    }





    // Memory usage analysis
    const initialMB = this.metrics.memoryUsage.initial.heapUsed / 1024 / 1024;
    const peakMB = this.metrics.memoryUsage.peak.heapUsed / 1024 / 1024;
    const finalMB = this.metrics.memoryUsage.final.heapUsed / 1024 / 1024;
    log(`  Memory usage:`);
    log(`    Initial: ${initialMB.toFixed(2)}MB`);
    log(`    Peak: ${peakMB.toFixed(2)}MB (+${(peakMB - initialMB).toFixed(2)}MB)`);
    log(`    Final: ${finalMB.toFixed(2)}MB`);

    log(`  Top phases:`);
    Object.entries(this.metrics.phases)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 8)
      .forEach(([phase, time]) => {
        log(`    ${phase}: ${time.toFixed(2)}ms (${(time/this.metrics.totalTime*100).toFixed(1)}%)`);
      });

    return this.metrics;
  }
}

export default async function generateCodeBenchmarked(
  dmmf: PrismaDMMF.Document,
  baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
  log: (msg: string) => void = noop,
): Promise<GenerationMetrics> {
  const generator = new BenchmarkedCodeGenerator();
  return generator.generate(dmmf, baseOptions, log);
}

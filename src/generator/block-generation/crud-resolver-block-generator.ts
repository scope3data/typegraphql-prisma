import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import generateCrudResolverClassFromMapping from "../resolvers/full-crud";
import generateActionResolverClass from "../resolvers/separate-action";
import generateArgsTypeClassFromArgs from "../args-class";
import {
  generateResolversBarrelFile,
  generateResolversActionsBarrelFile,
  generateArgsBarrelFile,
  generateArgsIndexFile,
  generateResolversIndexFile,
} from "../imports";
import {
  resolversFolderName,
  crudResolversFolderName,
  argsFolderName,
} from "../config";
import type { GenerateMappingData } from "../types";

export class CrudResolverBlockGenerator extends BaseBlockGenerator {
  protected shouldGenerate(): boolean {
    return this.dmmfDocument.shouldGenerateBlock("crudResolvers");
  }

  public getBlockName(): string {
    return "crudResolvers";
  }

  public async generate(): Promise<GenerationMetrics> {
    if (!this.shouldGenerate()) {
      return { itemsGenerated: 0 };
    }

    const startTime = performance.now();
    let totalItemsGenerated = 0;

    // Generate CRUD resolvers for each model mapping
    this.dmmfDocument.modelMappings.forEach(mapping => {
      // Use cached model lookup instead of find()
      const model = this.dmmfDocument.modelsCache.get(mapping.modelName);
      if (!model) {
        throw new Error(
          `No model found for mapping ${mapping.modelName}. This indicates a problem with the DMMF document processing.`,
        );
      }

      generateCrudResolverClassFromMapping(
        this.project,
        this.baseDirPath,
        mapping,
        model,
        this.dmmfDocument,
        this.options,
      );
      totalItemsGenerated++;

      mapping.actions.forEach(action => {
        generateActionResolverClass(
          this.project,
          this.baseDirPath,
          model,
          action,
          mapping,
          this.dmmfDocument,
          this.options,
        );
        totalItemsGenerated++;
      });
    });

    this.generateBarrelFiles();
    this.generateArgs();

    return {
      itemsGenerated: totalItemsGenerated,
      timeElapsed: performance.now() - startTime,
    };
  }

  private generateBarrelFiles(): void {
    const generateMappingData = this.dmmfDocument.modelMappings
      .map(mapping => {
        const model = this.dmmfDocument.modelsCache.get(mapping.modelName);
        if (!model) {
          throw new Error(
            `No model found for mapping ${mapping.modelName} when generating mapping data. This indicates a problem with the DMMF document processing.`,
          );
        }
        return {
          modelName: model.typeName,
          resolverName: mapping.resolverName,
          actionResolverNames: mapping.actions.map(it => it.actionResolverName),
        } as GenerateMappingData;
      })
      .filter(
        (item: GenerateMappingData | null): item is GenerateMappingData =>
          item !== null,
      );

    const crudResolversBarrelExportSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
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

    const crudResolversActionsBarrelExportSourceFile =
      this.project.createSourceFile(
        path.resolve(
          this.baseDirPath,
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

    const crudResolversIndexSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
        resolversFolderName,
        crudResolversFolderName,
        "index.ts",
      ),
      undefined,
      { overwrite: true },
    );
    generateResolversIndexFile(crudResolversIndexSourceFile, "crud", true);
  }

  private generateArgs(): void {
    this.dmmfDocument.modelMappings.forEach(mapping => {
      const actionsWithArgs = mapping.actions.filter(
        it => it.argsTypeName !== undefined,
      );

      if (actionsWithArgs.length) {
        const model = this.dmmfDocument.modelsCache.get(mapping.modelName);
        if (!model) {
          throw new Error(
            `No model found for mapping ${mapping.modelName} when generating CRUD resolver args. This indicates a problem with the DMMF document processing.`,
          );
        }
        const resolverDirPath = path.resolve(
          this.baseDirPath,
          resolversFolderName,
          crudResolversFolderName,
          model.typeName,
        );

        actionsWithArgs.forEach(action => {
          if (!action.argsTypeName) {
            throw new Error(
              `Expected argsTypeName to be defined for CRUD action after filtering, but got ${action.argsTypeName}`,
            );
          }
          generateArgsTypeClassFromArgs(
            this.project,
            resolverDirPath,
            action.method.args,
            action.argsTypeName,
            this.dmmfDocument,
          );
        });

        const barrelExportSourceFile = this.project.createSourceFile(
          path.resolve(resolverDirPath, argsFolderName, "index.ts"),
          undefined,
          { overwrite: true },
        );
        generateArgsBarrelFile(
          barrelExportSourceFile,
          actionsWithArgs.map(it => {
            if (!it.argsTypeName) {
              throw new Error(
                `Expected argsTypeName to be defined for CRUD action after filtering, but got ${it.argsTypeName}`,
              );
            }
            return it.argsTypeName;
          }),
        );
      }
    });

    const crudResolversArgsIndexSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
        resolversFolderName,
        crudResolversFolderName,
        "args.index.ts",
      ),
      undefined,
      { overwrite: true },
    );
    generateArgsIndexFile(
      crudResolversArgsIndexSourceFile,
      this.dmmfDocument.modelMappings
        .filter(mapping =>
          mapping.actions.some(it => it.argsTypeName !== undefined),
        )
        .map(mapping => mapping.modelTypeName),
    );
  }
}

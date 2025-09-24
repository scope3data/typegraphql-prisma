import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import generateRelationsResolverClassesFromModel from "../resolvers/relations";
import generateArgsTypeClassFromArgs from "../args-class";
import {
  generateResolversBarrelFile,
  generateArgsBarrelFile,
  generateArgsIndexFile,
  generateResolversIndexFile,
} from "../imports";
import {
  resolversFolderName,
  relationsResolversFolderName,
  argsFolderName,
} from "../config";
import type { GenerateMappingData } from "../types";

export class RelationResolverBlockGenerator extends BaseBlockGenerator {
  protected shouldGenerate(): boolean {
    return (
      this.dmmfDocument.relationModels.length > 0 &&
      this.dmmfDocument.shouldGenerateBlock("relationResolvers")
    );
  }

  public getBlockName(): string {
    return "relationResolvers";
  }

  public generate(): GenerationMetrics {
    if (!this.shouldGenerate()) {
      return { itemsGenerated: 0 };
    }

    const startTime = performance.now();

    // Generate relation resolvers
    this.dmmfDocument.relationModels.forEach(relationModel => {
      generateRelationsResolverClassesFromModel(
        this.project,
        this.baseDirPath,
        this.dmmfDocument,
        relationModel,
        this.options,
      );
    });

    this.generateBarrelFiles();
    this.generateArgs();

    return {
      itemsGenerated: this.dmmfDocument.relationModels.length,
      timeElapsed: performance.now() - startTime,
    };
  }

  private generateBarrelFiles(): void {
    const relationResolversBarrelExportSourceFile =
      this.project.createSourceFile(
        path.resolve(
          this.baseDirPath,
          resolversFolderName,
          relationsResolversFolderName,
          "resolvers.index.ts",
        ),
        undefined,
        { overwrite: true },
      );
    generateResolversBarrelFile(
      relationResolversBarrelExportSourceFile,
      this.dmmfDocument.relationModels.map<GenerateMappingData>(
        relationModel => ({
          resolverName: relationModel.resolverName,
          modelName: relationModel.model.typeName,
        }),
      ),
    );

    // Generate remaining relation resolver index files
    const relationModelsWithArgs = this.dmmfDocument.relationModels.filter(
      relationModelData =>
        relationModelData.relationFields.some(
          it => it.argsTypeName !== undefined,
        ),
    );

    if (relationModelsWithArgs.length > 0) {
      const relationResolversArgsIndexSourceFile =
        this.project.createSourceFile(
          path.resolve(
            this.baseDirPath,
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

    const relationResolversIndexSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
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

  private generateArgs(): void {
    this.dmmfDocument.relationModels.forEach(relationModelData => {
      const resolverDirPath = path.resolve(
        this.baseDirPath,
        resolversFolderName,
        relationsResolversFolderName,
        relationModelData.model.typeName,
      );

      const fieldsWithArgs = relationModelData.relationFields.filter(
        field => field.argsTypeName,
      );

      fieldsWithArgs.forEach(field => {
        if (!field.argsTypeName) {
          throw new Error(
            `Expected argsTypeName to be defined for relation field after filtering, but got ${field.argsTypeName}`,
          );
        }
        generateArgsTypeClassFromArgs(
          this.project,
          resolverDirPath,
          field.outputTypeField.args,
          field.argsTypeName,
          this.dmmfDocument,
        );
      });

      const argTypeNames = relationModelData.relationFields
        .filter(it => it.argsTypeName !== undefined)
        .map(it => {
          if (!it.argsTypeName) {
            throw new Error(
              `Expected argsTypeName to be defined after filtering, but got ${it.argsTypeName}`,
            );
          }
          return it.argsTypeName;
        });

      if (argTypeNames.length) {
        const barrelExportSourceFile = this.project.createSourceFile(
          path.resolve(resolverDirPath, argsFolderName, "index.ts"),
          undefined,
          { overwrite: true },
        );
        generateArgsBarrelFile(barrelExportSourceFile, argTypeNames);
      }
    });
  }
}

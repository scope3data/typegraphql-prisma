import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import generateObjectTypeClassFromModel from "../model-type-class";
import { generateModelsBarrelFile } from "../imports";
import { modelsFolderName } from "../config";

export class ModelBlockGenerator extends BaseBlockGenerator {
  protected shouldGenerate(): boolean {
    return this.dmmfDocument.shouldGenerateBlock("models");
  }

  public getBlockName(): string {
    return "models";
  }

  public generate(): GenerationMetrics {
    if (!this.shouldGenerate()) {
      return { itemsGenerated: 0 };
    }

    const startTime = performance.now();

    this.dmmfDocument.datamodel.models.forEach(model => {
      const modelOutputType = this.dmmfDocument.outputTypeCache.get(model.name);

      if (!modelOutputType) {
        throw new Error(
          `Model ${model.name} has no output type. This indicates a problem with the DMMF document processing.`,
        );
      }

      generateObjectTypeClassFromModel(
        this.project,
        this.baseDirPath,
        model,
        modelOutputType,
        this.dmmfDocument,
      );
    });

    const modelsBarrelExportSourceFile = this.project.createSourceFile(
      path.resolve(this.baseDirPath, modelsFolderName, "index.ts"),
      undefined,
      { overwrite: true },
    );
    generateModelsBarrelFile(
      modelsBarrelExportSourceFile,
      this.dmmfDocument.datamodel.models.map(it => it.typeName),
    );

    return {
      itemsGenerated: this.dmmfDocument.datamodel.models.length,
      timeElapsed: performance.now() - startTime,
    };
  }
}

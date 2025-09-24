import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import { generateInputTypeClassFromType } from "../type-class";
import { generateInputsBarrelFile } from "../imports";
import { resolversFolderName, inputsFolderName } from "../config";

export class InputBlockGenerator extends BaseBlockGenerator {
  protected shouldGenerate(): boolean {
    return this.dmmfDocument.shouldGenerateBlock("inputs");
  }

  public getBlockName(): string {
    return "inputs";
  }

  public generate(): GenerationMetrics {
    if (!this.shouldGenerate()) {
      return { itemsGenerated: 0 };
    }

    const startTime = performance.now();
    const resolversDirPath = path.resolve(
      this.baseDirPath,
      resolversFolderName,
    );
    const allInputTypes: string[] = [];

    this.dmmfDocument.schema.inputTypes.forEach(type => {
      allInputTypes.push(type.typeName);
      generateInputTypeClassFromType(
        this.project,
        resolversDirPath,
        type,
        this.options,
      );
    });

    const inputsBarrelExportSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
        resolversFolderName,
        inputsFolderName,
        "index.ts",
      ),
      undefined,
      { overwrite: true },
    );
    generateInputsBarrelFile(inputsBarrelExportSourceFile, allInputTypes);

    return {
      itemsGenerated: this.dmmfDocument.schema.inputTypes.length,
      timeElapsed: performance.now() - startTime,
    };
  }
}

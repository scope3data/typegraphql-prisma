import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import { generateOutputTypeClassFromType } from "../type-class";
import generateArgsTypeClassFromArgs from "../args-class";
import { generateOutputsBarrelFile, generateArgsBarrelFile } from "../imports";
import {
  resolversFolderName,
  outputsFolderName,
  argsFolderName,
} from "../config";
import type { DMMF } from "../dmmf/types";

export class OutputBlockGenerator extends BaseBlockGenerator {
  private outputTypesToGenerate: DMMF.OutputType[] = [];

  protected shouldGenerate(): boolean {
    return this.dmmfDocument.shouldGenerateBlock("outputs");
  }

  public getBlockName(): string {
    return "outputs";
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

    const rootTypes = this.dmmfDocument.schema.outputTypes.filter(type =>
      ["Query", "Mutation"].includes(type.name),
    );
    const modelNames = this.dmmfDocument.datamodel.models.map(
      model => model.name,
    );
    this.outputTypesToGenerate = this.dmmfDocument.schema.outputTypes.filter(
      type => !modelNames.includes(type.name) && !rootTypes.includes(type),
    );

    const outputTypesFieldsArgsToGenerate = this.outputTypesToGenerate
      .map(it => it.fields)
      .reduce((a, b) => a.concat(b), [])
      .filter(it => it.argsTypeName);

    this.outputTypesToGenerate.forEach(type => {
      generateOutputTypeClassFromType(
        this.project,
        resolversDirPath,
        type,
        this.dmmfDocument,
      );
    });

    if (outputTypesFieldsArgsToGenerate.length > 0) {
      outputTypesFieldsArgsToGenerate.forEach(field => {
        if (!field.argsTypeName) {
          throw new Error(
            `Expected argsTypeName to be defined for field after filtering, but got ${field.argsTypeName}`,
          );
        }
        generateArgsTypeClassFromArgs(
          this.project,
          path.resolve(resolversDirPath, outputsFolderName),
          field.args,
          field.argsTypeName,
          this.dmmfDocument,
          2,
        );
      });

      const outputsArgsBarrelExportSourceFile = this.project.createSourceFile(
        path.resolve(
          this.baseDirPath,
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
            throw new Error(
              `Expected argsTypeName to be defined after filtering, but got ${it.argsTypeName}`,
            );
          }
          return it.argsTypeName;
        }),
      );
    }

    const outputsBarrelExportSourceFile = this.project.createSourceFile(
      path.resolve(
        this.baseDirPath,
        resolversFolderName,
        outputsFolderName,
        "index.ts",
      ),
      undefined,
      { overwrite: true },
    );
    generateOutputsBarrelFile(
      outputsBarrelExportSourceFile,
      this.outputTypesToGenerate.map(it => it.typeName),
      this.outputTypesToGenerate.some(type =>
        type.fields.some(field => field.argsTypeName),
      ),
    );

    return {
      itemsGenerated: this.outputTypesToGenerate.length,
      timeElapsed: performance.now() - startTime,
    };
  }

  /**
   * Gets the generated output types - useful for other generators that need this information
   */
  public getGeneratedOutputTypes(): DMMF.OutputType[] {
    return this.outputTypesToGenerate;
  }
}

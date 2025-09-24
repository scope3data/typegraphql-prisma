import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BaseBlockGenerator,
  type GenerationMetrics,
} from "./base-block-generator";
import generateEnumFromDef from "../enum";
import { generateEnumsBarrelFile } from "../imports";
import { enumsFolderName } from "../config";

export class EnumBlockGenerator extends BaseBlockGenerator {
  protected shouldGenerate(): boolean {
    return this.dmmfDocument.shouldGenerateBlock("enums");
  }

  public getBlockName(): string {
    return "enums";
  }

  public generate(): GenerationMetrics {
    if (!this.shouldGenerate()) {
      return { itemsGenerated: 0 };
    }

    const startTime = performance.now();

    const allEnums = this.dmmfDocument.datamodel.enums.concat(
      this.dmmfDocument.schema.enums.filter(
        enumDef =>
          !this.dmmfDocument.datamodel.enums
            .map(e => e.typeName)
            .includes(enumDef.typeName),
      ),
    );

    allEnums.forEach(enumDef => {
      generateEnumFromDef(this.project, this.baseDirPath, enumDef);
    });

    const emittedEnumNames = Array.from(
      new Set(
        this.dmmfDocument.schema.enums
          .map(it => it.typeName)
          .concat(this.dmmfDocument.datamodel.enums.map(it => it.typeName)),
      ),
    );

    const enumsBarrelExportSourceFile = this.project.createSourceFile(
      path.resolve(this.baseDirPath, enumsFolderName, "index.ts"),
      undefined,
      { overwrite: true },
    );
    generateEnumsBarrelFile(enumsBarrelExportSourceFile, emittedEnumNames);

    return {
      itemsGenerated: allEnums.length,
      timeElapsed: performance.now() - startTime,
    };
  }
}

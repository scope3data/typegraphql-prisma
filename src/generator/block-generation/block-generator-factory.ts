import type { Project } from "ts-morph";
import type { DmmfDocument } from "../dmmf/dmmf-document";
import type { GeneratorOptions } from "../options";
import type { DMMF } from "../dmmf/types";
import {
  type BaseBlockGenerator,
  EnumBlockGenerator,
  ModelBlockGenerator,
  InputBlockGenerator,
  OutputBlockGenerator,
  CrudResolverBlockGenerator,
  RelationResolverBlockGenerator,
  type GenerationMetrics,
} from "./index";

export class BlockGeneratorFactory {
  private project: Project;
  private dmmfDocument: DmmfDocument;
  private options: GeneratorOptions;
  private baseDirPath: string;
  private generators: Map<string, BaseBlockGenerator> = new Map();

  constructor(
    project: Project,
    dmmfDocument: DmmfDocument,
    options: GeneratorOptions,
    baseDirPath: string,
  ) {
    this.project = project;
    this.dmmfDocument = dmmfDocument;
    this.options = options;
    this.baseDirPath = baseDirPath;

    this.initializeGenerators();
  }

  private initializeGenerators(): void {
    const enumGenerator = new EnumBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    const modelGenerator = new ModelBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    const inputGenerator = new InputBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    const outputGenerator = new OutputBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    const relationResolverGenerator = new RelationResolverBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    const crudResolverGenerator = new CrudResolverBlockGenerator(
      this.project,
      this.dmmfDocument,
      this.options,
      this.baseDirPath,
    );

    this.generators.set("enums", enumGenerator);
    this.generators.set("models", modelGenerator);
    this.generators.set("inputs", inputGenerator);
    this.generators.set("outputs", outputGenerator);
    this.generators.set("relationResolvers", relationResolverGenerator);
    this.generators.set("crudResolvers", crudResolverGenerator);
  }

  public async generateAllBlocks(
    log: (msg: string) => void,
    metricsCallback?: (blockName: string, metrics: GenerationMetrics) => void,
  ): Promise<DMMF.OutputType[]> {
    let outputTypesToGenerate: DMMF.OutputType[] = [];

    const blockOrder = [
      "enums",
      "models",
      "outputs",
      "inputs",
      "relationResolvers",
      "crudResolvers",
    ];

    for (const blockName of blockOrder) {
      const generator = this.generators.get(blockName);
      if (!generator) {
        continue;
      }

      log(`Generating ${generator.getBlockName()}...`);
      // note: this isn't a true async function, but we'll await it anyway
      // in the future, we can try to parallelize this
      const metrics = await generator.generate();

      if (metricsCallback && metrics.itemsGenerated > 0) {
        metricsCallback(blockName, metrics);
      }

      // Special case: capture output types for enhance map generation
      if (
        blockName === "outputs" &&
        generator instanceof OutputBlockGenerator
      ) {
        outputTypesToGenerate = generator.getGeneratedOutputTypes();
      }
    }

    return outputTypesToGenerate;
  }

  public getGenerator(blockName: string): BaseBlockGenerator | undefined {
    return this.generators.get(blockName);
  }

  public hasGenerator(blockName: string): boolean {
    return this.generators.has(blockName);
  }

  public getAllGenerators(): BaseBlockGenerator[] {
    return Array.from(this.generators.values());
  }
}

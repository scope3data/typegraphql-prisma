import type { Project } from "ts-morph";
import type { DmmfDocument } from "../dmmf/dmmf-document";
import type { GeneratorOptions } from "../options";

export abstract class BaseBlockGenerator {
  protected project: Project;
  protected dmmfDocument: DmmfDocument;
  protected options: GeneratorOptions;
  protected baseDirPath: string;

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
  }

  /**
   * Determines whether this block should be generated based on the current configuration
   */
  protected abstract shouldGenerate(): boolean;

  /**
   * Generates the block and returns metrics about the generation process
   */
  public abstract generate(): Promise<GenerationMetrics> | GenerationMetrics;

  /**
   * Returns the name of this block type for logging purposes
   */
  public abstract getBlockName(): string;
}

export interface GenerationMetrics {
  itemsGenerated: number;
  timeElapsed?: number;
}

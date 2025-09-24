import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { exec } from "node:child_process";

import type { DMMF as PrismaDMMF } from "@prisma/generator-helper";
import {
  Project,
  ScriptTarget,
  ModuleKind,
  type CompilerOptions,
} from "ts-morph";

import { noop, toUnixPath } from "./helpers";
import { generateIndexFile } from "./imports";
import type {
  InternalGeneratorOptions,
  ExternalGeneratorOptions,
  GeneratorOptions as BaseGeneratorOptions,
} from "./options";

import { DmmfDocument } from "./dmmf/dmmf-document";
import { BlockGeneratorFactory } from "./block-generation/block-generator-factory";

import { ensureInstalledCorrectPrismaPackage } from "../utils/prisma-version";
import { generateEnhanceMap } from "./generate-enhance";
import { generateCustomScalars } from "./generate-scalars";
import { generateHelpersFile } from "./generate-helpers";
import { getBlocksToEmit } from "./emit-block";
import type { MetricsListener } from "./metrics";

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
  constructor(private metrics?: MetricsListener) {}

  private resolveFormatGeneratedCodeOption(
    formatOption: boolean | "prettier" | "tsc" | "biome" | undefined,
  ): "prettier" | "tsc" | "biome" | undefined {
    if (formatOption === false) {
      return undefined; // No formatting, saved a lot of time
    }
    if (formatOption === undefined) {
      return "tsc"; // Default to tsc when not specified
    }
    if (formatOption === true) {
      return "tsc"; // true means use tsc
    }
    // formatOption is either 'prettier', 'tsc', or 'biome' string
    return formatOption;
  }

  async generate(
    dmmf: PrismaDMMF.Document,
    baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
    log: (msg: string) => void = noop,
  ): Promise<void> {
    const startTime = performance.now();
    ensureInstalledCorrectPrismaPackage();

    const options: BaseGeneratorOptions = Object.assign({}, baseOptions, {
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
      formatGeneratedCode: this.resolveFormatGeneratedCodeOption(
        baseOptions.formatGeneratedCode,
      ),
    });

    const baseDirPath = options.outputDirPath;
    const emitTranspiledCode =
      options.emitTranspiledCode ??
      options.outputDirPath.includes("node_modules");

    const project = new Project({
      compilerOptions: Object.assign(
        {},
        baseCompilerOptions,
        emitTranspiledCode
          ? {
              declaration: true,
              importHelpers: true,
            }
          : {},
      ),
    });

    log("Transforming dmmfDocument...");
    const dmmfStart = performance.now();
    const dmmfDocument = new DmmfDocument(dmmf, options);
    this.metrics?.emitMetric(
      "dmmf-document-creation",
      performance.now() - dmmfStart,
    );

    // Initialize block generator factory
    const blockGeneratorFactory = new BlockGeneratorFactory(
      project,
      dmmfDocument,
      options,
      baseDirPath,
    );

    // Generate all blocks using the factory
    const outputTypesToGenerate = await blockGeneratorFactory.generateAllBlocks(
      log,
      (blockName, metrics) => {
        if (this.metrics && metrics.timeElapsed) {
          this.metrics.emitMetric(
            `${blockName}-generation`,
            metrics.timeElapsed,
            metrics.itemsGenerated,
          );
        }
      },
    );

    // Generate auxiliary files
    log("Generate auxiliary files");
    const auxiliaryStart = performance.now();
    const enhanceSourceFile = project.createSourceFile(
      `${baseDirPath}/enhance.ts`,
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
      `${baseDirPath}/scalars.ts`,
      undefined,
      { overwrite: true },
    );
    generateCustomScalars(scalarsSourceFile, dmmfDocument.options);

    const helpersSourceFile = project.createSourceFile(
      `${baseDirPath}/helpers.ts`,
      undefined,
      { overwrite: true },
    );
    generateHelpersFile(helpersSourceFile, dmmfDocument.options);

    const indexSourceFile = project.createSourceFile(
      `${baseDirPath}/index.ts`,
      undefined,
      { overwrite: true },
    );
    generateIndexFile(
      indexSourceFile,
      dmmfDocument.relationModels.length > 0,
      dmmfDocument.options.blocksToEmit,
    );
    this.metrics?.emitMetric(
      "auxiliary-files",
      performance.now() - auxiliaryStart,
    );

    log("Emitting final code");
    const emitStart = performance.now();
    if (emitTranspiledCode) {
      log("Transpiling generated code");
      await project.emit();
    } else {
      log("Saving generated code");
      const saveStart = performance.now();
      await project.save();
      this.metrics?.emitMetric("save-files", performance.now() - saveStart);
    }

    // Format generated code if enabled
    if (options.formatGeneratedCode) {
      try {
        log(`Formatting generated code with ${options.formatGeneratedCode}`);
        const formatStart = performance.now();

        if (options.formatGeneratedCode === "tsc") {
          // Use tsc for formatting
          const tscStart = performance.now();
          const tscArgs = ["--noEmit", "--project", baseDirPath];
          await execa(`tsc ${tscArgs.join(" ")}`, { cwd: baseDirPath });
          this.metrics?.emitMetric(
            "tsc-formatting",
            performance.now() - tscStart,
          );
        } else if (options.formatGeneratedCode === "prettier") {
          // Use prettier for formatting
          const prettierStart = performance.now();
          const prettierArgs = [
            "--write",
            `${baseDirPath}/**/*.ts`,
            "--ignore-path",
            path.resolve(baseDirPath, ".prettierignore"),
          ];

          // Check if prettier config exists, if not use default config
          try {
            await fs.promises.access(path.resolve(baseDirPath, ".prettierrc"));
          } catch {
            prettierArgs.push(
              "--config",
              JSON.stringify({
                semi: true,
                trailingComma: "es5",
                singleQuote: false,
                printWidth: 120,
                tabWidth: 2,
                useTabs: false,
              }),
            );
          }

          await execa(`npx prettier ${prettierArgs.join(" ")}`, {
            cwd: baseDirPath,
          });
          this.metrics?.emitMetric(
            "prettier-formatting",
            performance.now() - prettierStart,
          );
        } else {
          // Use biome for formatting
          const biomeStart = performance.now();
          const biomeArgs = ["format", "--write", `${baseDirPath}/**/*.ts`];

          // Check if biome config exists, if not use default behavior
          try {
            await fs.promises.access(path.resolve(baseDirPath, "biome.json"));
          } catch {
            // Biome will use its default configuration if no config file is found
          }

          await execa(`npx biome ${biomeArgs.join(" ")}`, { cwd: baseDirPath });
          this.metrics?.emitMetric(
            "biome-formatting",
            performance.now() - biomeStart,
          );
        }

        this.metrics?.emitMetric(
          "code-formatting",
          performance.now() - formatStart,
        );
      } catch (error) {
        // Don't fail the entire generation for formatting errors
        log(
          `Warning: Code formatting failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.metrics?.emitMetric("code-emission", performance.now() - emitStart);
    this.metrics?.emitMetric("total-generation", performance.now() - startTime);
    this.metrics?.onComplete?.();
  }
}

export default async function generateCode(
  dmmf: PrismaDMMF.Document,
  baseOptions: InternalGeneratorOptions & ExternalGeneratorOptions,
  log: (msg: string) => void = noop,
  metrics?: MetricsListener,
): Promise<void> {
  const generator = new CodeGenerator(metrics);
  return generator.generate(dmmf, baseOptions, log);
}

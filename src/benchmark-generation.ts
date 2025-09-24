#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDMMF } from "@prisma/internals";
import { Command } from "commander";
import generateCode from "./generator/generate-code";
import { SimpleMetricsCollector } from "./generator/metrics";
import { GeneratorOptions } from "./generator/options";

interface BenchmarkOptions {
  schemaPath: string;
  outputDir: string;
  formatType?: "biome" | "prettier" | "tsc" | "none" | undefined;
  iterations?: number;
  cleanup?: boolean;
}

class CodeGenerationBenchmark {
  private options: BenchmarkOptions;

  constructor(options: BenchmarkOptions) {
    this.options = {
      iterations: 1,
      cleanup: true,
      ...options,
    };
  }

  async run(): Promise<void> {
    console.log("🚀 TypeGraphQL-Prisma Code Generation Benchmark");
    console.log("=".repeat(60));
    console.log(`📋 Schema: ${this.options.schemaPath}`);
    console.log(`📁 Output: ${this.options.outputDir}`);
    console.log(`🔄 Iterations: ${this.options.iterations}`);

    try {
      // Validate schema file exists
      await this.validateSchemaFile();

      // Read and analyze schema
      const schemaContent = await fs.readFile(this.options.schemaPath, "utf-8");
      console.log(
        `📊 Schema size: ${Math.round(schemaContent.length / 1024)}KB`,
      );

      // Parse DMMF
      console.log("\n⏳ Parsing schema...");
      const parseStart = performance.now();
      const dmmf = await getDMMF({
        datamodel: schemaContent,
      });
      const parseTime = performance.now() - parseStart;
      console.log(`✅ Schema parsed in ${parseTime.toFixed(2)}ms`);

      // Analyze schema complexity
      this.analyzeSchema(dmmf);

      // Run benchmark iterations
      const results = await this.runIterations(dmmf);

      // Display final results (this includes file counting)
      await this.displayResults(results);

      if (this.options.cleanup) {
        await this.cleanup();
      }
    } catch (error) {
      console.error("❌ Benchmark failed:", error);
      if (error instanceof Error) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  private async validateSchemaFile(): Promise<void> {
    try {
      await fs.access(this.options.schemaPath);
    } catch {
      throw new Error(`Schema file not found: ${this.options.schemaPath}`);
    }
  }

  private analyzeSchema(dmmf: any): void {
    const models = dmmf.datamodel.models.length;
    const enums = dmmf.datamodel.enums.length;
    const inputTypes =
      (dmmf.schema.inputObjectTypes.prisma?.length || 0) +
      (dmmf.schema.inputObjectTypes.model?.length || 0);
    const outputTypes =
      dmmf.schema.outputObjectTypes.prisma.length +
      dmmf.schema.outputObjectTypes.model.length;
    const totalComplexity =
      models * 10 + enums * 2 + inputTypes * 1 + outputTypes * 3;

    console.log("\n📊 Schema Statistics:");
    console.log(`  Models: ${models}`);
    console.log(`  Enums: ${enums}`);
    console.log(`  Input Types: ${inputTypes}`);
    console.log(`  Output Types: ${outputTypes}`);
    console.log(`  Complexity Score: ${totalComplexity}`);
  }

  private async runIterations(
    dmmf: any,
  ): Promise<Array<{ iteration: number; totalTime: number; metrics: any[] }>> {
    const results: Array<{
      iteration: number;
      totalTime: number;
      metrics: any[];
    }> = [];
    const iterations = this.options.iterations || 1;

    for (let i = 0; i < iterations; i++) {
      console.log(`\n🔄 Running iteration ${i + 1}/${iterations}...`);

      // Clean output directory
      await this.prepareOutputDirectory();

      // Create metrics collector
      const metricsCollector = new SimpleMetricsCollector();

      // Setup generation options
      const generatorOptions: GeneratorOptions = {
        outputDirPath: this.options.outputDir,
        prismaClientPath: "./node_modules/.prisma/client",
        emitTranspiledCode: false,
        formatGeneratedCode:
          this.options.formatType === "none" ? false : this.options.formatType,
        contextPrismaKey: "prisma",
        emitRedundantTypesInfo: false,
        emitIsAbstract: false,
        blocksToEmit: [
          "enums",
          "models",
          "inputs",
          "outputs",
          "crudResolvers",
          "relationResolvers",
        ],
        relativePrismaOutputPath: "../../../node_modules/.prisma/client",
        customPrismaImportPath: undefined,
        omitInputFieldsByDefault: [],
        omitOutputFieldsByDefault: [],
        absolutePrismaOutputPath: undefined,
      };

      // Run generation with metrics
      const iterationStart = performance.now();

      await generateCode(
        dmmf,
        generatorOptions,
        (_msg: string) => {}, // Silent log function for cleaner output
        metricsCollector,
      );

      const iterationTime = performance.now() - iterationStart;

      results.push({
        iteration: i + 1,
        totalTime: iterationTime,
        metrics: metricsCollector.getMetrics(),
      });

      console.log(
        `✅ Iteration ${i + 1} completed in ${iterationTime.toFixed(2)}ms`,
      );
    }

    return results;
  }

  private async displayResults(
    results: Array<{ iteration: number; totalTime: number; metrics: any[] }>,
  ): Promise<void> {
    if (results.length === 0) return;

    console.log("\n📈 FINAL BENCHMARK RESULTS");
    console.log("=".repeat(60));

    if (results.length === 1) {
      console.log(`🕐 Generation Time: ${results[0].totalTime.toFixed(2)}ms`);
    } else {
      const times = results.map(r => r.totalTime);
      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const stdDev = Math.sqrt(
        times.reduce((sq, time) => sq + Math.pow(time - avgTime, 2), 0) /
          times.length,
      );

      console.log(`🕐 Average Time: ${avgTime.toFixed(2)}ms`);
      console.log(
        `📏 Min/Max: ${minTime.toFixed(2)}ms / ${maxTime.toFixed(2)}ms`,
      );
      console.log(`📊 Std Deviation: ${stdDev.toFixed(2)}ms`);
      console.log(
        `🎯 Consistency: ${((1 - stdDev / avgTime) * 100).toFixed(1)}%`,
      );
    }

    // Check generated files
    await this.displayOutputInfo();
  }

  private async displayOutputInfo(): Promise<void> {
    try {
      const files = await this.countGeneratedFiles();
      console.log(`📁 Generated Files: ${files}`);
    } catch (error) {
      console.log("📁 Could not count generated files");
    }
  }

  private async countGeneratedFiles(): Promise<number> {
    const countFilesRecursively = async (dir: string): Promise<number> => {
      let count = 0;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            count += await countFilesRecursively(path.join(dir, entry.name));
          } else if (entry.name.endsWith(".ts")) {
            count++;
          }
        }
      } catch (error) {
        // Directory doesn't exist or can't be read
        return 0;
      }

      return count;
    };

    return countFilesRecursively(this.options.outputDir);
  }

  private async prepareOutputDirectory(): Promise<void> {
    try {
      await fs.rm(this.options.outputDir, { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }
    await fs.mkdir(this.options.outputDir, { recursive: true });
  }

  private async cleanup(): Promise<void> {
    try {
      await fs.rm(this.options.outputDir, { recursive: true, force: true });
      console.log("\n🧹 Cleaned up output directory");
    } catch (error) {
      console.log("\n⚠️  Could not clean up output directory");
    }
  }
}

// Parse command line arguments using Commander
function parseArgs(): BenchmarkOptions {
  const program = new Command();

  program
    .name("benchmark-code")
    .description("🚀 TypeGraphQL-Prisma Code Generation Benchmark")
    .version("1.0.0")
    .option(
      "-s, --schema <path>",
      "Path to Prisma schema file",
      "./test-schemas/large-schema.prisma",
    )
    .option(
      "-o, --output <path>",
      "Output directory for generated files",
      "./benchmark-output",
    )
    .option(
      "-i, --iterations <number>",
      "Number of iterations to run",
      value => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed < 1) {
          throw new Error(
            "Invalid iterations count - must be a positive integer",
          );
        }
        return parsed;
      },
      1,
    )
    .option(
      "--format-type <string>",
      "Format generated code using biome, prettier, tsc, or none",
      undefined,
    )
    .option("--no-cleanup", "Keep generated files after benchmark")
    .addHelpText(
      "after",
      `
Examples:
  npm run benchmark-code
  npm run benchmark-code -- --schema ./test-schemas/small-schema.prisma
  npm run benchmark-code -- --schema ./my-schema.prisma --iterations 5
  npm run benchmark-code -- --no-cleanup --output ./my-output`,
    );

  program.parse();
  const options = program.opts();

  return {
    schemaPath: options.schema,
    outputDir: options.output,
    formatType: options.formatType,
    iterations: options.iterations,
    cleanup: options.cleanup,
  };
}

// Main execution
if (require.main === module) {
  (async () => {
    try {
      const options = parseArgs();
      const benchmark = new CodeGenerationBenchmark(options);
      await benchmark.run();
    } catch (error) {
      console.error(
        "❌ Error:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  })();
}

export default CodeGenerationBenchmark;

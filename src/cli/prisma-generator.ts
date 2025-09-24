import { GeneratorOptions } from "@prisma/generator-helper";
import { getDMMF, parseEnvValue } from "@prisma/internals";
import { promises as asyncFs } from "fs";
import path from "path";
import { performance } from "node:perf_hooks";
import { SimpleMetricsCollector } from "../generator/metrics";

import generateCode from "../generator/generate-code";
import removeDir from "../utils/removeDir";
import {
  ExternalGeneratorOptions,
  InternalGeneratorOptions,
} from "../generator/options";
import { ALL_EMIT_BLOCK_KINDS } from "../generator/emit-block";
import {
  parseStringBoolean,
  parseStringArray,
  parseStringEnum,
  parseString,
} from "./helpers";

export async function generate(options: GeneratorOptions) {
  const totalStart = performance.now();
  console.log("🚀 TypeGraphQL Generator Started");
  // console.log(options, 'options!')

  const outputDir = parseEnvValue(options.generator.output!);

  // Parse verboseLogging option early to control all logging
  const verboseLogging =
    parseStringBoolean(options.generator.config.verboseLogging) ?? false;

  console.log(verboseLogging, "verboseLogging!");

  // Create logging function based on verboseLogging option
  const log = (message: string) => {
    if (verboseLogging) {
      console.log(message);
    }
  };

  const dirSetupStart = performance.now();
  await asyncFs.mkdir(outputDir, { recursive: true });
  await removeDir(outputDir, true);
  log(
    `📁 Directory setup: ${(performance.now() - dirSetupStart).toFixed(2)}ms`,
  );

  const prismaSetupStart = performance.now();
  const prismaClientProvider = options.otherGenerators.find(
    it => parseEnvValue(it.provider) === "prisma-client-js",
  )!;
  const prismaClientPath = parseEnvValue(prismaClientProvider.output!);
  log(
    `🔍 Prisma client provider lookup: ${(performance.now() - prismaSetupStart).toFixed(2)}ms`,
  );

  const dmmfStart = performance.now();
  const prismaClientDmmf = await getDMMF({
    datamodel: options.datamodel,
    previewFeatures: prismaClientProvider.previewFeatures,
  });
  log(`📊 DMMF generation: ${(performance.now() - dmmfStart).toFixed(2)}ms`);

  const configStart = performance.now();
  const generatorConfig = options.generator.config;
  // TODO: make this type `?-` and `| undefined`
  const externalConfig: ExternalGeneratorOptions = {
    emitDMMF: parseStringBoolean(generatorConfig.emitDMMF),
    emitTranspiledCode: parseStringBoolean(generatorConfig.emitTranspiledCode),
    simpleResolvers: parseStringBoolean(generatorConfig.simpleResolvers),
    useOriginalMapping: parseStringBoolean(generatorConfig.useOriginalMapping),
    useUncheckedScalarInputs: parseStringBoolean(
      generatorConfig.useUncheckedScalarInputs,
    ),
    emitIdAsIDType: parseStringBoolean(generatorConfig.emitIdAsIDType),
    emitOnly: parseStringArray(
      generatorConfig.emitOnly,
      "emitOnly",
      ALL_EMIT_BLOCK_KINDS,
    ),
    useSimpleInputs: parseStringBoolean(generatorConfig.useSimpleInputs),
    emitRedundantTypesInfo: parseStringBoolean(
      generatorConfig.emitRedundantTypesInfo,
    ),
    customPrismaImportPath: parseString(
      generatorConfig.customPrismaImportPath,
      "customPrismaImportPath",
    ),
    contextPrismaKey: parseString(
      generatorConfig.contextPrismaKey,
      "contextPrismaKey",
    ),
    omitInputFieldsByDefault: parseStringArray(
      generatorConfig.omitInputFieldsByDefault,
      "omitInputFieldsByDefault",
    ),
    omitOutputFieldsByDefault: parseStringArray(
      generatorConfig.omitOutputFieldsByDefault,
      "omitOutputFieldsByDefault",
    ),
    formatGeneratedCode:
      parseStringBoolean(generatorConfig.formatGeneratedCode) ??
      parseStringEnum(
        generatorConfig.formatGeneratedCode,
        "formatGeneratedCode",
        ["prettier", "tsc"] as const,
      ),
    emitIsAbstract: parseStringBoolean(generatorConfig.emitIsAbstract) ?? false,
    verboseLogging,
  };
  const internalConfig: InternalGeneratorOptions = {
    outputDirPath: outputDir,
    prismaClientPath,
  };

  log(`⚙️  Config parsing: ${(performance.now() - configStart).toFixed(2)}ms`);

  if (externalConfig.emitDMMF) {
    const dmmfWriteStart = performance.now();
    await Promise.all([
      asyncFs.writeFile(
        path.resolve(outputDir, "./dmmf.json"),
        JSON.stringify(options.dmmf, null, 2),
      ),
      asyncFs.writeFile(
        path.resolve(outputDir, "./prisma-client-dmmf.json"),
        JSON.stringify(prismaClientDmmf, null, 2),
      ),
    ]);
    log(
      `💾 DMMF file writing: ${(performance.now() - dmmfWriteStart).toFixed(2)}ms`,
    );
  }

  // TODO: replace with `options.dmmf` when the spec match prisma client output
  const codeGenStart = performance.now();

  // Add detailed comparison logging
  log(`📊 DMMF Comparison:`);
  log(`  Models: ${prismaClientDmmf.datamodel.models.length}`);
  log(`  Enums: ${prismaClientDmmf.datamodel.enums.length}`);
  log(
    `  Input Types (prisma): ${prismaClientDmmf.schema.inputObjectTypes.prisma?.length || 0}`,
  );
  log(
    `  Input Types (model): ${prismaClientDmmf.schema.inputObjectTypes.model?.length || 0}`,
  );
  log(
    `  Output Types (prisma): ${prismaClientDmmf.schema.outputObjectTypes.prisma.length}`,
  );
  log(
    `  Output Types (model): ${prismaClientDmmf.schema.outputObjectTypes.model.length}`,
  );

  log(`⚙️  Config Comparison:`);
  log(`  formatGeneratedCode: ${externalConfig.formatGeneratedCode}`);
  log(`  emitTranspiledCode: ${externalConfig.emitTranspiledCode}`);
  log(`  outputDirPath: ${internalConfig.outputDirPath}`);
  log(`  customPrismaImportPath: ${externalConfig.customPrismaImportPath}`);

  // Create metrics collector for detailed analysis
  const metricsCollector = new SimpleMetricsCollector(verboseLogging);

  await generateCode(
    prismaClientDmmf,
    {
      ...externalConfig,
      ...internalConfig,
    },
    (msg: string) => log(`📝 ${msg}`),
    metricsCollector,
  );

  const codeGenTime = performance.now() - codeGenStart;
  log(`🎯 Core code generation: ${codeGenTime.toFixed(2)}ms`);

  const totalTime = performance.now() - totalStart;
  log(`✅ Total generator time: ${totalTime.toFixed(2)}ms`);
  log(`📈 Overhead (non-core): ${(totalTime - codeGenTime).toFixed(2)}ms`);

  return "";
}

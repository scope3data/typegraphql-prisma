import type { Project, SourceFile } from "ts-morph";
import path from "node:path";

import { resolversFolderName, crudResolversFolderName } from "../config";
import {
  generateTypeGraphQLImport,
  generateArgsImports,
  generateModelsImports,
  generateOutputsImports,
  generateGraphQLInfoImport,
  generateHelpersFileImport,
} from "../imports";
import { generateCrudResolverClassMethodDeclaration } from "./helpers";
import type { DmmfDocument } from "../dmmf/dmmf-document";
import type { DMMF } from "../dmmf/types";
import type { GeneratorOptions } from "../options";

export default function generateActionResolverClass(
  project: Project,
  baseDirPath: string,
  model: DMMF.Model,
  action: DMMF.Action,
  mapping: DMMF.ModelMapping,
  dmmfDocument: DmmfDocument,
  generatorOptions: GeneratorOptions,
): SourceFile {
  const sourceFile = project.createSourceFile(
    path.resolve(
      baseDirPath,
      resolversFolderName,
      crudResolversFolderName,
      model.typeName,
      `${action.actionResolverName}.ts`,
    ),
    undefined,
    { overwrite: true },
  );

  generateTypeGraphQLImport(sourceFile);
  generateGraphQLInfoImport(sourceFile);
  if (action.argsTypeName) {
    generateArgsImports(sourceFile, [action.argsTypeName], 0);
  }
  generateModelsImports(
    sourceFile,
    [model.typeName, action.outputTypeName].filter(typeName =>
      dmmfDocument.isModelTypeName(typeName),
    ),
    3,
  );
  generateOutputsImports(
    sourceFile,
    [action.outputTypeName].filter(
      typeName => !dmmfDocument.isModelTypeName(typeName),
    ),
    2,
  );
  generateHelpersFileImport(sourceFile, 3);

  sourceFile.addClass({
    name: action.actionResolverName,
    isExported: true,
    decorators: [
      {
        name: "TypeGraphQL.Resolver",
        arguments: [`_of => ${model.typeName}`],
      },
    ],
    methods: [
      generateCrudResolverClassMethodDeclaration(
        action,
        mapping,
        dmmfDocument,
        generatorOptions,
      ),
    ],
  });

  return sourceFile;
}

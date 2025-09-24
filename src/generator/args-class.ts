import {
  type PropertyDeclarationStructure,
  type OptionalKind,
  type Project,
  Writers,
  type SourceFile,
} from "ts-morph";
import path from "node:path";

import { argsFolderName } from "./config";
import {
  generateTypeGraphQLImport,
  generateInputsImports,
  generateEnumsImports,
  generateGraphQLScalarsImport,
} from "./imports";
import type { DmmfDocument } from "./dmmf/dmmf-document";
import type { DMMF } from "./dmmf/types";

export default function generateArgsTypeClassFromArgs(
  project: Project,
  generateDirPath: string,
  fields: readonly DMMF.SchemaArg[],
  argsTypeName: string,
  _dmmfDocument: DmmfDocument,
  inputImportsLevel = 3,
): SourceFile {
  const dirPath = path.resolve(generateDirPath, argsFolderName);
  const filePath = path.resolve(dirPath, `${argsTypeName}.ts`);
  const sourceFile = project.createSourceFile(filePath, undefined, {
    overwrite: true,
  });

  generateTypeGraphQLImport(sourceFile);
  generateGraphQLScalarsImport(sourceFile);
  generateInputsImports(
    sourceFile,
    fields
      .map(arg => arg.selectedInputType)
      .filter(argInputType => argInputType.location === "inputObjectTypes")
      .map(argInputType => argInputType.type),
    inputImportsLevel,
  );
  generateEnumsImports(
    sourceFile,
    fields
      .map(field => field.selectedInputType)
      .filter(argType => argType.location === "enumTypes")
      .map(argType => argType.type as string),
    4,
  );

  sourceFile.addClass({
    name: argsTypeName,
    isExported: true,
    decorators: [
      {
        name: "TypeGraphQL.ArgsType",
        arguments: [],
      },
    ],
    properties: fields.map<OptionalKind<PropertyDeclarationStructure>>(arg => {
      return {
        name: arg.typeName,
        type: arg.fieldTSType,
        hasExclamationToken: arg.isRequired,
        hasQuestionToken: !arg.isRequired,
        trailingTrivia: "\r\n",
        decorators: [
          {
            name: "TypeGraphQL.Field",
            arguments: [
              `_type => ${arg.typeGraphQLType}`,
              Writers.object({
                nullable: `${!arg.isRequired}`,
              }),
            ],
          },
        ],
      };
    }),
  });

  return sourceFile;
}

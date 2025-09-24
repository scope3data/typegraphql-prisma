import {
  PropertyDeclarationStructure,
  OptionalKind,
  Project,
  GetAccessorDeclarationStructure,
  Writers,
} from "ts-morph";
import path from "path";

import {
  generateTypeGraphQLImport,
  generateModelsImports,
  generateEnumsImports,
  generateGraphQLScalarsImport,
  generatePrismaNamespaceImport,
  generateCustomScalarsImport,
  generateResolversOutputsImports,
} from "./imports";
import { modelsFolderName } from "./config";
import { DMMF } from "./dmmf/types";
import { DmmfDocument } from "./dmmf/dmmf-document";
import { convertNewLines } from "./helpers";

export default function generateObjectTypeClassFromModel(
  project: Project,
  baseDirPath: string,
  model: DMMF.Model,
  modelOutputType: DMMF.OutputType,
  dmmfDocument: DmmfDocument,
) {
  const dirPath = path.resolve(baseDirPath, modelsFolderName);
  const filePath = path.resolve(dirPath, `${model.typeName}.ts`);
  const sourceFile = project.createSourceFile(filePath, undefined, {
    overwrite: true,
  });

  generateTypeGraphQLImport(sourceFile);
  generateGraphQLScalarsImport(sourceFile);
  generatePrismaNamespaceImport(sourceFile, dmmfDocument.options, 1);
  generateCustomScalarsImport(sourceFile, 1);
  generateModelsImports(
    sourceFile,
    model.fields
      .filter(field => field.location === "outputObjectTypes")
      .filter(field => field.type !== model.name)
      .map(field =>
        dmmfDocument.isModelName(field.type)
          ? dmmfDocument.getModelTypeName(field.type)!
          : field.type,
      ),
  );
  generateEnumsImports(
    sourceFile,
    model.fields
      .filter(field => field.location === "enumTypes")
      .map(field => field.type),
  );

  const countField = dmmfDocument.getOutputTypeField(
    modelOutputType.name,
    "_count",
  );
  const shouldEmitCountField =
    countField !== undefined &&
    dmmfDocument.shouldGenerateBlock("crudResolvers");
  if (shouldEmitCountField) {
    generateResolversOutputsImports(sourceFile, [countField.typeGraphQLType]);
  }

  sourceFile.addClass({
    name: model.typeName,
    isExported: true,
    decorators: model.isOmitted.output
      ? []
      : [
          {
            name: "TypeGraphQL.ObjectType",
            arguments: [
              `"${model.typeName}"`,
              (() => {
                const options = [];
                if (dmmfDocument.options.emitIsAbstract)
                  options.push("isAbstract: true");
                if (model.docs) options.push(`description: "${model.docs}"`);
                if (dmmfDocument.options.simpleResolvers)
                  options.push("simpleResolvers: true");
                return options.length > 0 ? `{ ${options.join(", ")} }` : "{}";
              })(),
            ],
          },
        ],
    properties: [
      ...model.fields.map<OptionalKind<PropertyDeclarationStructure>>(field => {
        const isOptional =
          !!field.relationName ||
          field.isOmitted.output ||
          (!field.isRequired && field.typeFieldAlias === undefined);

        return {
          name: field.name,
          type: field.fieldTSType,
          hasExclamationToken: !isOptional,
          hasQuestionToken: isOptional,
          trailingTrivia: "\r\n",
          decorators: [
            ...(field.relationName ||
            field.typeFieldAlias ||
            field.isOmitted.output
              ? []
              : [
                  {
                    name: "TypeGraphQL.Field",
                    arguments: [
                      `_type => ${field.typeGraphQLType}`,
                      (() => {
                        const options = [`nullable: ${isOptional}`];
                        if (field.docs)
                          options.push(`description: "${field.docs}"`);
                        return `{ ${options.join(", ")} }`;
                      })(),
                    ],
                  },
                ]),
          ],
          ...(field.docs && {
            docs: [{ description: `\n${convertNewLines(field.docs)}` }],
          }),
        };
      }),
      ...(shouldEmitCountField
        ? [
            {
              name: countField.name,
              type: countField.fieldTSType,
              hasExclamationToken: countField.isRequired,
              hasQuestionToken: !countField.isRequired,
              trailingTrivia: "\r\n",
              decorators: [
                {
                  name: "TypeGraphQL.Field",
                  arguments: [
                    `_type => ${countField.typeGraphQLType}`,
                    `{ nullable: ${!countField.isRequired} }`,
                  ],
                },
              ],
            },
          ]
        : []),
    ],
    getAccessors: model.fields
      .filter(
        field =>
          field.typeFieldAlias &&
          !field.relationName &&
          !field.isOmitted.output,
      )
      .map<OptionalKind<GetAccessorDeclarationStructure>>(field => {
        return {
          name: field.typeFieldAlias!,
          returnType: field.fieldTSType,
          trailingTrivia: "\r\n",
          decorators: [
            {
              name: "TypeGraphQL.Field",
              arguments: [
                `_type => ${field.typeGraphQLType}`,
                (() => {
                  const options = [`nullable: ${!field.isRequired}`];
                  if (field.docs) options.push(`description: "${field.docs}"`);
                  return `{ ${options.join(", ")} }`;
                })(),
              ],
            },
          ],
          statements: [
            field.isRequired
              ? `return this.${field.name};`
              : `return this.${field.name} ?? null;`,
          ],
          ...(field.docs && {
            docs: [{ description: `\n${convertNewLines(field.docs)}` }],
          }),
        };
      }),
    ...(model.docs && {
      docs: [{ description: `\n${convertNewLines(model.docs)}` }],
    }),
  });
}

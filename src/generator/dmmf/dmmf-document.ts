import type { DMMF as PrismaDMMF } from "@prisma/generator-helper";

import type { DMMF } from "./types";
import {
  transformSchema,
  transformMappings,
  transformBareModel,
  transformModelWithFields,
  transformEnums,
  generateRelationModel,
  clearOutputTypeNameCache,
} from "./transform";
import type { GeneratorOptions } from "../options";
import type { EmitBlockKind } from "../emit-block";

export class DmmfDocument implements DMMF.Document {
  private models: DMMF.Model[];
  datamodel: DMMF.Datamodel;
  schema: DMMF.Schema;
  enums: DMMF.Enum[];
  modelMappings: DMMF.ModelMapping[];
  relationModels: DMMF.RelationModel[];

  outputTypeCache: Map<string, DMMF.OutputType>;
  modelsCache: Map<string, DMMF.Model>;
  modelTypeNameCache: Set<string>;
  fieldAliasCache: Map<string, Map<string, string>>;

  // Additional performance caches
  enumsCache: Map<string, DMMF.Enum>;
  modelFieldsCache: Map<string, Map<string, any>>;
  outputTypeFieldsCache: Map<string, Map<string, any>>;

  constructor(
    { datamodel, schema, mappings }: PrismaDMMF.Document,
    public options: GeneratorOptions,
  ) {
    // Clear module-level caches to prevent pollution between test runs
    clearOutputTypeNameCache();

    // Initialize caches
    this.outputTypeCache = new Map();
    this.modelsCache = new Map();
    this.modelTypeNameCache = new Set();
    this.fieldAliasCache = new Map();

    // Initialize additional performance caches
    this.enumsCache = new Map();
    this.modelFieldsCache = new Map();
    this.outputTypeFieldsCache = new Map();

    const enumTypes = (schema.enumTypes.prisma ?? []).concat(
      schema.enumTypes.model ?? [],
    );
    const models = datamodel.models.concat(datamodel.types);

    // transform bare model without fields
    this.models = models.map(transformBareModel);
    // transform enums before model fields to map enum types to enum values string union
    this.enums = enumTypes.map(transformEnums(this));

    // then transform once again to map the fields (it requires mapped model type names)
    // this also inits the modelTypeNameCache and fieldAliasCache
    this.models = models.map(model => {
      const transformed = transformModelWithFields(this)(model);

      this.modelsCache.set(model.name, transformed);
      this.modelTypeNameCache.add(transformed.typeName);

      // Cache field aliases for this model
      const fieldAliases = new Map<string, string>();
      const modelFields = new Map<string, any>();

      transformed.fields.forEach(field => {
        // Cache field by name for fast lookup
        modelFields.set(field.name, field);

        if (field.typeFieldAlias) {
          fieldAliases.set(field.name, field.typeFieldAlias);
        }
      });

      // Store field cache for this model
      this.modelFieldsCache.set(model.name, modelFields);

      if (fieldAliases.size > 0) {
        this.fieldAliasCache.set(model.name, fieldAliases);
      }

      return transformed;
    });

    // transform enums again to map renamed fields
    this.enums = enumTypes.map(enumType => {
      const transformed = transformEnums(this)(enumType);
      this.enumsCache.set(enumType.name, transformed);
      return transformed;
    });

    this.datamodel = {
      models: this.models,
      enums: datamodel.enums.map(transformEnums(this)),
      types: [], // TODO: parse `datamodel.types`
    };

    this.schema = {
      ...transformSchema(schema, this),
      enums: this.enums,
    };

    this.schema.outputTypes.forEach(outputType => {
      this.outputTypeCache.set(outputType.name, outputType);

      // Cache output type fields for fast lookup
      const fieldsCache = new Map<string, any>();
      outputType.fields.forEach(field => {
        fieldsCache.set(field.name, field);
      });
      this.outputTypeFieldsCache.set(outputType.name, fieldsCache);
    });

    this.modelMappings = transformMappings(
      mappings.modelOperations,
      this,
      options,
    );

    this.relationModels = this.models
      .filter(model =>
        model.fields.some(
          field => field.relationName !== undefined && !field.isOmitted.output,
        ),
      )
      .filter(model => {
        const outputType = this.outputTypeCache.get(model.name);
        return outputType?.fields.some(outputTypeField =>
          model.fields.some(
            modelField =>
              modelField.name === outputTypeField.name &&
              modelField.relationName !== undefined &&
              !modelField.isOmitted.output,
          ),
        );
      })
      .map(generateRelationModel(this));
  }

  getModelTypeName(modelName: string): string | undefined {
    // Try cache first for exact match
    const cachedModel = this.modelsCache.get(modelName);
    if (cachedModel) {
      return cachedModel.typeName;
    }

    // Fallback to case-insensitive search
    return this.models.find(
      it => it.name.toLocaleLowerCase() === modelName.toLocaleLowerCase(),
    )?.typeName;
  }

  isModelName(typeName: string): boolean {
    return this.modelsCache.has(typeName);
  }

  isModelTypeName(typeName: string): boolean {
    return this.modelTypeNameCache.has(typeName);
  }

  getModelFieldAlias(modelName: string, fieldName: string): string | undefined {
    const fieldAliases = this.fieldAliasCache.get(modelName);
    return fieldAliases?.get(fieldName);
  }

  shouldGenerateBlock(block: EmitBlockKind): boolean {
    return this.options.blocksToEmit.includes(block);
  }

  getEnumByTypeName(typeName: string): DMMF.Enum | undefined {
    return this.enumsCache.get(typeName);
  }

  getModelField(modelName: string, fieldName: string): any | undefined {
    const modelFields = this.modelFieldsCache.get(modelName);
    return modelFields?.get(fieldName);
  }

  getOutputTypeField(
    outputTypeName: string,
    fieldName: string,
  ): any | undefined {
    const outputTypeFields = this.outputTypeFieldsCache.get(outputTypeName);
    return outputTypeFields?.get(fieldName);
  }

  findOutputTypeWithField(fieldName: string): DMMF.OutputType | undefined {
    for (const outputType of this.outputTypeCache.values()) {
      if (this.outputTypeFieldsCache.get(outputType.name)?.has(fieldName)) {
        return outputType;
      }
    }
    return undefined;
  }
}

import { Worker } from 'node:worker_threads';
import { EnumMemberStructure, OptionalKind, Project } from "ts-morph";
import path from "node:path";

import { generateTypeGraphQLImport } from "../imports";
import { enumsFolderName } from "../config";
import { DMMF } from "../dmmf/types";
import { convertNewLines } from "../helpers";

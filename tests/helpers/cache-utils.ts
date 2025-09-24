import { clearOutputTypeNameCache } from "../../src/generator/dmmf/transform";

export function clearAllCaches(): void {
  clearOutputTypeNameCache();
}

export function clearOutputTypeCache(): void {
  clearOutputTypeNameCache();
}

/** The JSON Schema subset used by our generated OpenAPI. Not a general validator. */
export function schemaErrors(
  schema: any,
  value: unknown,
  root: any,
  path = "data",
): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    let resolved = root;
    for (const part of schema.$ref.slice(2).split("/"))
      resolved = resolved?.[part];
    return resolved
      ? schemaErrors(resolved, value, root, path)
      : [path + ": unresolved schema"];
  }
  if (schema.anyOf)
    return schema.anyOf.some(
      (s: any) => schemaErrors(s, value, root, path).length === 0,
    )
      ? []
      : [path + ": 不符合允许的类型"];
  if (schema.oneOf)
    return schema.oneOf.filter(
      (s: any) => schemaErrors(s, value, root, path).length === 0,
    ).length === 1
      ? []
      : [path + ": 不符合互斥类型"];
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const)
    errors.push(path + ": 常量无效");
  if (schema.enum && !schema.enum.includes(value))
    errors.push(path + ": 枚举值无效");
  const type = schema.type;
  if (type === "null") return value === null ? errors : [path + ": 应为null"];
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return [path + ": 应为对象"];
    const record = value as Record<string, unknown>;
    for (const field of schema.required || [])
      if (!(field in record))
        errors.push(path + "." + field + ": 缺少必需字段");
    for (const [key, child] of Object.entries(record)) {
      if (schema.properties?.[key])
        errors.push(
          ...schemaErrors(
            schema.properties[key],
            child,
            root,
            path + "." + key,
          ),
        );
      else if (schema.additionalProperties === false)
        errors.push(path + "." + key + ": 未声明字段");
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        errors.push(
          ...schemaErrors(
            schema.additionalProperties,
            child,
            root,
            path + "." + key,
          ),
        );
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [path + ": 应为数组"];
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(path + ": 条目不足");
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(path + ": 条目过多");
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      errors.push(path + ": 条目不能重复");
    value.forEach((child, i) =>
      errors.push(...schemaErrors(schema.items, child, root, `${path}[${i}]`)),
    );
  } else if (type === "string") {
    if (typeof value !== "string") return [path + ": 应为字符串"];
    const length = [...value].length;
    if (
      (schema.minLength !== undefined && length < schema.minLength) ||
      (schema.maxLength !== undefined && length > schema.maxLength)
    )
      errors.push(path + ": 长度无效");
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      errors.push(path + ": 字符格式无效");
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value)))
      errors.push(path + ": 时间格式无效");
  } else if (type === "number" || type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    )
      return [path + ": 数值类型无效"];
    if (
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      errors.push(path + ": 数值超出范围");
  } else if (type === "boolean" && typeof value !== "boolean")
    errors.push(path + ": 应为布尔值");
  return errors;
}
export function operationFor(contract: any, path: string, method: string): any {
  const clean = path.split("?")[0];
  if (contract.paths[clean]?.[method.toLowerCase()])
    return contract.paths[clean][method.toLowerCase()];
  for (const [template, methods] of Object.entries(contract.paths)) {
    const pattern = template
      .split(/(\{[^}]+\})/)
      .map((piece) =>
        piece.startsWith("{")
          ? "[^/]+"
          : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    if (new RegExp("^" + pattern + "$").test(clean))
      return (methods as any)[method.toLowerCase()];
  }
}

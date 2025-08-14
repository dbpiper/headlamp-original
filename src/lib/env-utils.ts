export type EnvInput = NodeJS.ProcessEnv | Record<string, unknown>;

export const safeEnv = (
  ...sources: EnvInput[]
): Record<string, string | undefined> => {
  const normalizedEnv: Record<string, string | undefined> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value == null) {
        normalizedEnv[key] = undefined;
      } else {
        switch (typeof value) {
          case "string":
            normalizedEnv[key] = value;
            break;
          case "boolean":
          case "number":
          case "bigint":
            normalizedEnv[key] = String(value);
            break;
          default:
            break;
        }
      }
    }
  }
  return normalizedEnv;
};

// "an empty secret field keeps the stored one": the body without an empty secret
export function withoutEmptySecret<T extends { tokenSecret?: string }>(form: T): T {
  const { tokenSecret, ...rest } = form;
  return (tokenSecret ? { ...rest, tokenSecret } : rest) as T;
}

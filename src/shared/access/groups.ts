export function groupsFromClaims(payload: Record<string, unknown>, claim = 'groups'): string[] {
  const value = payload[claim];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export function isAdmin(groups: readonly string[], adminGroup: string): boolean {
  const expected = adminGroup.trim();
  if (!expected) return false;
  return groups.some((group) => group === expected);
}

import type { ConflictDomain, DependencyEdge } from "./contracts.js";

export interface ParallelismCandidate {
  readonly issueNumber: number;
  readonly conflictDomains: readonly ConflictDomain[];
}

export interface ParallelismDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function assertAcyclicDependencies(
  issueNumbers: readonly number[],
  edges: readonly DependencyEdge[],
): void {
  const included = new Set(issueNumbers);
  const adjacency = new Map<number, number[]>();

  for (const issueNumber of issueNumbers) adjacency.set(issueNumber, []);
  for (const edge of edges) {
    if (
      !included.has(edge.prerequisiteIssueNumber) ||
      !included.has(edge.dependentIssueNumber)
    ) {
      throw new Error("dependency edge references an issue outside the sprint");
    }
    adjacency.get(edge.prerequisiteIssueNumber)?.push(edge.dependentIssueNumber);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();

  function visit(issueNumber: number): void {
    if (visiting.has(issueNumber)) throw new Error("dependency graph contains a cycle");
    if (visited.has(issueNumber)) return;

    visiting.add(issueNumber);
    for (const dependent of adjacency.get(issueNumber) ?? []) visit(dependent);
    visiting.delete(issueNumber);
    visited.add(issueNumber);
  }

  for (const issueNumber of issueNumbers) visit(issueNumber);
}

export function decideParallelism(
  first: ParallelismCandidate,
  second: ParallelismCandidate,
  edges: readonly DependencyEdge[],
  activeImplementationCount: number,
): ParallelismDecision {
  if (!Number.isSafeInteger(activeImplementationCount) || activeImplementationCount < 0) {
    throw new Error("activeImplementationCount must be a nonnegative integer");
  }

  const reasons: string[] = [];

  if (first.issueNumber === second.issueNumber) reasons.push("same_issue");
  if (activeImplementationCount >= 2) reasons.push("parallel_limit_reached");
  if (hasDependencyPath(first.issueNumber, second.issueNumber, edges)) {
    reasons.push("dependency_path");
  }
  if (hasDependencyPath(second.issueNumber, first.issueNumber, edges)) {
    reasons.push("dependency_path");
  }
  if (
    [...first.conflictDomains, ...second.conflictDomains].some(
      (domain) => domain.confidence === "low",
    )
  ) {
    reasons.push("low_confidence");
  }
  if (domainsOverlap(first.conflictDomains, second.conflictDomains)) {
    reasons.push("conflict_domain_overlap");
  }

  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function hasDependencyPath(
  start: number,
  target: number,
  edges: readonly DependencyEdge[],
): boolean {
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const dependents = adjacency.get(edge.prerequisiteIssueNumber) ?? [];
    dependents.push(edge.dependentIssueNumber);
    adjacency.set(edge.prerequisiteIssueNumber, dependents);
  }

  const pending = [...(adjacency.get(start) ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function domainsOverlap(
  first: readonly ConflictDomain[],
  second: readonly ConflictDomain[],
): boolean {
  return first.some((left) =>
    second.some((right) => {
      if (left.kind !== right.kind) return false;
      if (left.kind !== "path") return left.value === right.value;

      const leftPath = normalizePath(left.value);
      const rightPath = normalizePath(right.value);
      return (
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`)
      );
    }),
  );
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/$/, "");
}

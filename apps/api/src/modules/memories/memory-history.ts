import type { Prisma, PrismaClient } from "@prisma/client";

type MemoryDb = Prisma.TransactionClient | PrismaClient;

/**
 * Remove automatically extracted facts for deleted source objects while
 * preserving a single, ordered history chain for every entity attribute.
 * Memory facts intentionally do not have foreign keys to heterogeneous source
 * tables, so lifecycle cleanup must be explicit and transactional.
 */
export async function deleteMemoryFactsBySources(db: MemoryDb, userId: string, sourceIds: string[]) {
  if (!sourceIds.length) return;
  const affected = await db.memoryFact.findMany({
    where: { sourceId: { in: sourceIds }, entity: { userId } },
    select: { entityId: true },
  });
  const entityIds = [...new Set(affected.map((fact) => fact.entityId))];
  for (const entityId of entityIds) {
    const facts = await db.memoryFact.findMany({ where: { entityId } });
    const ordered: typeof facts = [];
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const targets = new Set(facts.flatMap((fact) => fact.supersededById ? [fact.supersededById] : []));
    for (const head of facts.filter((fact) => !targets.has(fact.id))) {
      let cursor: typeof head | undefined = head;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        ordered.push(cursor);
        seen.add(cursor.id);
        cursor = cursor.supersededById ? byId.get(cursor.supersededById) : undefined;
      }
    }
    for (const fact of facts) if (!ordered.some((item) => item.id === fact.id)) ordered.push(fact);
    await db.memoryFact.updateMany({ where: { entityId }, data: { supersededById: null } });
    await db.memoryFact.deleteMany({ where: { entityId, sourceId: { in: sourceIds }, userEdited: false } });
    const remaining = ordered.filter((fact) => fact.userEdited || !sourceIds.includes(fact.sourceId));
    const byAttribute = new Map<string, typeof remaining>();
    for (const fact of remaining) byAttribute.set(fact.attribute, [...(byAttribute.get(fact.attribute) ?? []), fact]);
    for (const chain of byAttribute.values()) {
      for (let index = 0; index < chain.length - 1; index++) {
        await db.memoryFact.update({ where: { id: chain[index].id }, data: { supersededById: chain[index + 1].id } });
      }
    }
  }
  if (entityIds.length) await db.memoryEntity.deleteMany({ where: { id: { in: entityIds }, userId, facts: { none: {} } } });
}

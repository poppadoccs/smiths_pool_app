"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { DEFAULT_TEMPLATE, type FormField } from "@/lib/forms";

const DEFAULT_SYSTEM_KEY = "default_pool_installation";

/**
 * Ensures the hardcoded DEFAULT_TEMPLATE exists in the DB as a real record.
 * Concurrency-safe — upserts on a unique systemKey column so concurrent
 * requests cannot create duplicates (Postgres unique constraint enforced).
 */
export async function ensureDefaultTemplate() {
  const result = await db.formTemplate.upsert({
    where: { systemKey: DEFAULT_SYSTEM_KEY },
    update: {},
    create: {
      systemKey: DEFAULT_SYSTEM_KEY,
      name: DEFAULT_TEMPLATE.name,
      description: "Standard pool installation form",
      category: "Installation",
      fields: DEFAULT_TEMPLATE.fields as unknown as Prisma.InputJsonValue,
      isDefault: true,
    },
    select: { id: true },
  });
  return result.id;
}

export async function listTemplates() {
  return db.formTemplate.findMany({
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      isDefault: true,
      fields: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { jobs: true } },
    },
  });
}

export async function getTemplate(id: string) {
  return db.formTemplate.findUnique({ where: { id } });
}

export async function createTemplate(data: {
  name: string;
  description?: string;
  category?: string;
  fields: FormField[];
}): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!data.name.trim()) {
    return { success: false, error: "Template name is required" };
  }

  const template = await db.formTemplate.create({
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || null,
      category: data.category?.trim() || null,
      fields: data.fields as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/templates");
  return { success: true, id: template.id };
}

export async function updateTemplate(
  id: string,
  data: {
    name?: string;
    description?: string;
    category?: string;
    fields?: FormField[];
  }
): Promise<{ success: boolean; error?: string }> {
  const existing = await db.formTemplate.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Template not found" };

  await db.formTemplate.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.description !== undefined && {
        description: data.description.trim() || null,
      }),
      ...(data.category !== undefined && {
        category: data.category.trim() || null,
      }),
      ...(data.fields !== undefined && {
        fields: data.fields as unknown as Prisma.InputJsonValue,
      }),
    },
  });

  revalidatePath("/templates");
  revalidatePath(`/templates/${id}`);
  return { success: true };
}

export async function deleteTemplate(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const existing = await db.formTemplate.findUnique({
    where: { id },
    include: { _count: { select: { jobs: true } } },
  });

  if (!existing) return { success: false, error: "Template not found" };
  if (existing.isDefault)
    return { success: false, error: "Cannot delete the default template" };
  if (existing._count.jobs > 0)
    return {
      success: false,
      error: `This template is used by ${existing._count.jobs} job(s). Remove them first.`,
    };

  await db.formTemplate.delete({ where: { id } });

  revalidatePath("/templates");
  return { success: true };
}

export async function duplicateTemplate(
  id: string
): Promise<{ success: boolean; id?: string; error?: string }> {
  const existing = await db.formTemplate.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Template not found" };

  const copy = await db.formTemplate.create({
    data: {
      name: `${existing.name} (Copy)`,
      description: existing.description,
      category: existing.category,
      fields: existing.fields as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/templates");
  return { success: true, id: copy.id };
}

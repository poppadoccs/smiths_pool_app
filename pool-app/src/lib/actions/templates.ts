"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import type { FormField } from "@/lib/forms";

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

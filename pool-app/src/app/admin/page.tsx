import type { Metadata } from "next";
import { AdminSettings } from "@/components/admin-settings";
import { getRecipientEmail, getAllManagedJobs } from "@/lib/actions/settings";

export const metadata: Metadata = {
  title: "Settings | Pool Field Forms",
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const [currentEmail, allJobs] = await Promise.all([
    getRecipientEmail(),
    getAllManagedJobs(),
  ]);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <h1 className="text-2xl font-bold text-zinc-900">Settings</h1>
      <p className="mt-1 text-base text-zinc-500">
        Manage submissions and app settings.
      </p>
      <AdminSettings currentEmail={currentEmail} allJobs={allJobs} />
    </main>
  );
}

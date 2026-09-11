"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type SaveHandler = () => Promise<void>;
type SavePhase = "prepare" | "save";
type Participant = { save: SaveHandler; phase: SavePhase };
type FormUpdater = (values: Record<string, string>) => void;
type JobSaves = {
  register: (id: string, save: SaveHandler, phase: SavePhase) => () => void;
  saveAll: () => Promise<void>;
  runAfterSave: <T>(action: () => Promise<T>) => Promise<T>;
  isSaving: boolean;
  registerFormUpdater: (update: FormUpdater) => () => void;
  updateFormFields: FormUpdater;
};

const JobSaveContext = createContext<JobSaves | null>(null);

// One provider per job joins the RHF form and the independent summary
// writers. Submission stays inside the same lock, so editing cannot resume
// between the last save and the server's status change.
export function JobSaveProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<string, Participant>());
  const busy = useRef(false);
  const formUpdater = useRef<FormUpdater | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const registerFormUpdater = useCallback((update: FormUpdater) => {
    formUpdater.current = update;
    return () => {
      if (formUpdater.current === update) formUpdater.current = null;
    };
  }, []);
  const updateFormFields = useCallback((values: Record<string, string>) => {
    // Legacy photo assignments also own ordinary field mirrors. Keep RHF
    // current so its next save cannot overwrite a just-saved assignment.
    formUpdater.current?.(values);
  }, []);

  const register = useCallback(
    (id: string, save: SaveHandler, phase: SavePhase) => {
      const participant = { save, phase };
      handlers.current.set(id, participant);
      return () => {
        if (handlers.current.get(id) === participant)
          handlers.current.delete(id);
      };
    },
    [],
  );

  const runAfterSave = useCallback(async <T,>(action: () => Promise<T>) => {
    if (busy.current) throw new Error("A save is already in progress.");
    if (!handlers.current.has("form")) {
      throw new Error("The form is not ready to save. Please try again.");
    }
    busy.current = true;
    setIsSaving(true);
    try {
      // Wait for every writer even when one fails, keeping the form locked
      // until the other writes settle. A failed writer must block submit.
      // Upload/assignment completion can change form values. Finish those
      // first, then ask the field writers for their latest snapshots.
      for (const phase of ["prepare", "save"] as const) {
        const results = await Promise.allSettled(
          Array.from(handlers.current.values())
            .filter((participant) => participant.phase === phase)
            .map(({ save }) => Promise.resolve().then(save)),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      return await action();
    } finally {
      busy.current = false;
      setIsSaving(false);
    }
  }, []);

  const saveAll = useCallback(
    () => runAfterSave(async () => undefined),
    [runAfterSave],
  );
  const value = useMemo(
    () => ({
      register,
      saveAll,
      runAfterSave,
      isSaving,
      registerFormUpdater,
      updateFormFields,
    }),
    [
      register,
      saveAll,
      runAfterSave,
      isSaving,
      registerFormUpdater,
      updateFormFields,
    ],
  );

  return (
    <JobSaveContext.Provider value={value}>{children}</JobSaveContext.Provider>
  );
}

export function useJobSaves() {
  const saves = useContext(JobSaveContext);
  if (!saves) throw new Error("Job form must be inside JobSaveProvider");
  return saves;
}

export function useJobSaveHandler(
  id: string | null,
  save: SaveHandler,
  phase: SavePhase = "save",
) {
  const { register } = useJobSaves();
  useEffect(
    () => (id === null ? undefined : register(id, save, phase)),
    [register, id, save, phase],
  );
}

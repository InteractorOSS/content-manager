"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiDraftDialog } from "@/components/cms/ai-draft-dialog";
import { useMe } from "@/hooks/use-me";

export function AiDraftButton() {
  const { can } = useMe();
  const [open, setOpen] = useState(false);

  if (!can("content:create")) return null;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Sparkles className="mr-2 h-4 w-4" />
        Draft with AI
      </Button>
      {open && <AiDraftDialog onClose={() => setOpen(false)} />}
    </>
  );
}

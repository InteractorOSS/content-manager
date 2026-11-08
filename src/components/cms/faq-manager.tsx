"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, Globe, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listFaqs, createFaq, updateFaq, deleteFaq } from "@/lib/api";
import { FAQ_CATEGORIES, FAQ_AUDIENCES, FAQ_STATUSES } from "@/lib/faq";
import type { Faq } from "@/types/cms";

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const faqSchema = z.object({
  question: z.string().min(1, "Question is required"),
  answer: z.string().min(1, "Answer is required"),
  category: z.enum(FAQ_CATEGORIES),
  audience: z.enum(FAQ_AUDIENCES).default("sales-only"),
  status: z.enum(FAQ_STATUSES).default("draft"),
  last_verified: z.string().default(""),
  verify_every_days: z.coerce.number().default(365),
  sources: z.string().default(""),
  related: z.string().default(""),
});

type FaqFormInput = z.input<typeof faqSchema>;
type FaqForm = z.output<typeof faqSchema>;

interface FaqDialogProps {
  faq?: Faq;
  open: boolean;
  onClose: () => void;
}

function FaqDialog({ faq, open, onClose }: FaqDialogProps) {
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FaqFormInput, unknown, FaqForm>({
    resolver: zodResolver(faqSchema),
    defaultValues: {
      question: faq?.question ?? "",
      answer: faq?.answer ?? "",
      category: faq?.category ?? "pricing",
      audience: faq?.audience ?? "sales-only",
      status: faq?.status ?? "draft",
      last_verified: faq?.last_verified?.slice(0, 10) ?? "",
      verify_every_days: faq?.verify_every_days ?? 365,
      sources: faq?.sources.join("\n") ?? "",
      related: faq?.related.join("\n") ?? "",
    },
  });

  const mutation = useMutation({
    mutationFn: (data: FaqForm) => {
      const values = {
        question: data.question,
        answer: data.answer,
        category: data.category,
        audience: data.audience,
        status: data.status,
        last_verified: data.last_verified || undefined,
        verify_every_days: data.verify_every_days,
        sources: linesToArray(data.sources),
        related: linesToArray(data.related),
      };
      return faq ? updateFaq(faq.id, values) : createFaq(values);
    },
    onSuccess: () => {
      toast.success(faq ? "FAQ updated" : "FAQ created");
      queryClient.invalidateQueries({ queryKey: ["faqs"] });
      reset();
      onClose();
    },
    onError: () => toast.error("Failed to save FAQ"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{faq ? "Edit FAQ" : "New FAQ"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
          <div className="space-y-2">
            <Label>Question</Label>
            <Input placeholder="What does it cost to..." {...register("question")} />
            {errors.question && <p className="text-xs text-destructive">{errors.question.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Answer</Label>
            <Textarea
              placeholder="Markdown — use {{facts.someKey}} for values that must stay in sync with product facts"
              className="font-mono text-sm resize-none"
              rows={8}
              {...register("answer")}
            />
            {errors.answer && <p className="text-xs text-destructive">{errors.answer.message}</p>}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={watch("category")} onValueChange={(v) => setValue("category", v as FaqForm["category"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FAQ_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Audience</Label>
              <Select value={watch("audience")} onValueChange={(v) => setValue("audience", v as FaqForm["audience"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FAQ_AUDIENCES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={watch("status")} onValueChange={(v) => setValue("status", v as FaqForm["status"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FAQ_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Last verified</Label>
              <Input type="date" {...register("last_verified")} />
            </div>
            <div className="space-y-2">
              <Label>Re-verify every (days)</Label>
              <Input type="number" {...register("verify_every_days")} />
              <p className="text-xs text-muted-foreground">Use 90 for anything that states a price.</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Sources (one URL per line)</Label>
            <Textarea rows={3} className="font-mono text-xs resize-none" {...register("sources")} />
          </div>

          <div className="space-y-2">
            <Label>Related FAQ slugs (one per line)</Label>
            <Textarea rows={2} className="font-mono text-xs resize-none" {...register("related")} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {faq ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FaqManager() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Faq | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Faq | null>(null);

  const { data: faqs = [], isLoading } = useQuery<Faq[]>({
    queryKey: ["faqs"],
    queryFn: () => listFaqs(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFaq(id),
    onSuccess: () => {
      toast.success("FAQ deleted");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["faqs"] });
    },
    onError: () => toast.error("Failed to delete FAQ"),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditTarget(undefined);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          New FAQ
        </Button>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Question</TableHead>
              <TableHead className="w-32">Category</TableHead>
              <TableHead className="w-28">Audience</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-20">Asked</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {faqs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-10">
                  <p className="text-sm text-muted-foreground">No FAQs yet</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setDialogOpen(true)}>
                    Create first FAQ
                  </Button>
                </TableCell>
              </TableRow>
            ) : (
              faqs.map((faq) => (
                <TableRow key={faq.id}>
                  <TableCell className="font-medium text-sm max-w-md">
                    <div className="flex items-center gap-2">
                      {faq.audience === "public" ? (
                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="truncate">{faq.question}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{faq.category}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{faq.audience}</TableCell>
                  <TableCell>
                    <Badge variant={faq.status === "published" ? "default" : "outline"}>{faq.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{faq.asked_count}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => {
                          setEditTarget(faq);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(faq)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <FaqDialog
        faq={editTarget}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditTarget(undefined);
        }}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete FAQ</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete &ldquo;{deleteTarget?.question}&rdquo;?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

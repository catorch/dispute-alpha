import { useMutation } from "@tanstack/react-query";
import { type DocumentDto, UPLOAD_MAX_BYTES, UPLOAD_MIME, UPLOADABLE_DOC_TYPES } from "@da/shared";
import { useRef, useState } from "react";
import { upload } from "../lib/api";
import { docStatusLabel, fmtDate, humanize } from "../lib/format";
import { Button, Empty, ErrorText, Input, Select, StatusChip, Table } from "./ui";

/** Multipart upload with a type picker. The server sniffs the real file type and scans before release. */
export function UploadForm({ path, onDone }: { path: string; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const m = useMutation({
    mutationFn: ({ file, type }: { file: File; type: string }) => upload<DocumentDto>(path, file, type),
    onSuccess: () => {
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const type = String(new FormData(e.currentTarget).get("type") ?? "");
        const file = fileRef.current?.files?.[0];
        if (!type) return setError("Choose a document type");
        if (!file) return setError("Choose a file");
        if (file.size > UPLOAD_MAX_BYTES) return setError("Files must be 25 MB or smaller");
        setError(undefined);
        m.mutate({ file, type });
      }}
    >
      <Select label="Document type" name="type" options={UPLOADABLE_DOC_TYPES} placeholder="Choose…" />
      <Input ref={fileRef} label="File" type="file" accept={UPLOAD_MIME.join(",")} hint="PDF, JPEG, PNG, or HEIC up to 25 MB" className="py-1.5" />
      <Button type="submit" busy={m.isPending}>
        Upload
      </Button>
      <div className="sm:col-span-3" aria-live="polite">
        {error && <p className="text-xs font-medium text-neg">{error}</p>}
        <ErrorText error={m.error} />
        {m.isSuccess && <p className="text-sm text-pos">Uploaded. It will be available after a security scan.</p>}
      </div>
    </form>
  );
}

export function DocumentsTable({ docs, downloadUrl }: { docs: DocumentDto[]; downloadUrl: (id: string) => string }) {
  if (!docs.length) return <Empty>No documents yet.</Empty>;
  return (
    <Table caption="Documents">
      <thead>
        <tr>
          <th>File</th>
          <th>Type</th>
          <th>Status</th>
          <th>Uploaded</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id}>
            <td className="max-w-56 break-words font-medium">{d.filename}</td>
            <td>{humanize(d.type)}</td>
            <td>
              <StatusChip status={d.status} label={docStatusLabel(d.status)} />
            </td>
            <td className="whitespace-nowrap">{fmtDate(d.createdAt)}</td>
            <td>
              {d.status === "available" && (
                <a href={downloadUrl(d.id)} className="link" download>
                  Download<span className="sr-only"> {d.filename}</span>
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

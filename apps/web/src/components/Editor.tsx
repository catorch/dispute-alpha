/** TipTap rich-text editor. Default export so pages can React.lazy() it into its own chunk. */
import type { ReactNode } from "react";
import { Icon } from "./icons";
import { ITEM_MERGE_FIELDS, MERGE_FIELDS } from "@da/shared";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

const loopMarkers = (h: string) => (h.match(/\{\{\s*[#/]each/g) ?? []).length;
const LOOP_SNIPPET = "<p>{{#each items}}</p><p><strong>{{item.furnisher}}</strong>, account {{item.account_mask}}: {{item.reason}}</p><p>{{/each}}</p>";

export type EditorProps = {
  value: string;
  onChange?: (html: string) => void;
  editable?: boolean;
  label: string;
  /** Show the merge-field insert menu (template editor). */
  mergeFields?: boolean;
  /** Called when the visual editor could not keep `{{#each}}` markers (e.g. a loop directly inside <ul>). */
  onLossyLoad?: () => void;
};

export default function Editor({ value, onChange, editable = true, label, mergeFields, onLossyLoad }: EditorProps) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content: value,
    editable,
    onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
    onCreate: ({ editor }) => {
      if (loopMarkers(value) !== loopMarkers(editor.getHTML())) onLossyLoad?.();
    },
    editorProps: { attributes: { "aria-label": label, "aria-multiline": "true", role: "textbox", class: "tiptap" } },
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive("bold"),
      italic: !!e?.isActive("italic"),
      h2: !!e?.isActive("heading", { level: 2 }),
      bullet: !!e?.isActive("bulletList"),
      ordered: !!e?.isActive("orderedList"),
    }),
  });
  if (!editor) return null;
  const btn = (content: ReactNode, pressed: boolean | undefined, run: () => void, aria: string) => (
    <button
      type="button"
      aria-label={aria}
      title={aria}
      aria-pressed={pressed}
      onClick={run}
      disabled={!editable}
      className={`grid h-8 min-w-8 place-items-center rounded-lg px-1.5 text-[14px] transition-colors ${pressed ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-fill hover:text-ink"} disabled:opacity-40`}
    >
      {content}
    </button>
  );
  const sep = <span aria-hidden className="mx-1 h-5 w-px bg-line" />;
  const c = () => editor.chain().focus();
  return (
    <div className="overflow-hidden rounded-2xl ring-1 ring-line">
      {editable && (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface px-2 py-1.5">
          {btn(<span className="font-bold">B</span>, s?.bold, () => c().toggleBold().run(), "Bold")}
          {btn(<span className="font-serif italic">I</span>, s?.italic, () => c().toggleItalic().run(), "Italic")}
          {btn(<span className="font-semibold">H</span>, s?.h2, () => c().toggleHeading({ level: 2 }).run(), "Heading")}
          {sep}
          {btn(<Icon name="listBullet" />, s?.bullet, () => c().toggleBulletList().run(), "Bulleted list")}
          {btn(<Icon name="listNumber" />, s?.ordered, () => c().toggleOrderedList().run(), "Numbered list")}
          {sep}
          {btn(<Icon name="undo" />, undefined, () => c().undo().run(), "Undo")}
          {btn(<Icon name="redo" />, undefined, () => c().redo().run(), "Redo")}
          {mergeFields && (
            <>
              <label className="ml-auto flex items-center gap-1.5 text-[13px] text-ink-2">
                <Icon name="braces" className="size-4 text-ink-3" />
                <span className="sr-only sm:not-sr-only">Insert field</span>
                <select
                  className="select-chevron h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) c().insertContent(`{{${e.target.value}}}`).run();
                  }}
                >
                  <option value="">Choose…</option>
                  <optgroup label="Letter">
                    {MERGE_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Per item (inside the items loop)">
                    {ITEM_MERGE_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </optgroup>
                </select>
              </label>
              {btn(<Icon name="repeat" />, undefined, () => c().insertContent(LOOP_SNIPPET).run(), "Insert items loop")}
            </>
          )}
        </div>
      )}
      <div className="paper-desk">
        <div className="paper letter-body">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

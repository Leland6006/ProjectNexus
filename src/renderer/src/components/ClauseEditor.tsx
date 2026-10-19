import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Italic, List, ListOrdered, Redo2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  value: string
  onChange: (html: string) => void
  editable?: boolean
  placeholder?: string
}

function ToolbarButton({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={cn('rounded p-1.5 text-ink-700 hover:bg-slate-100', active && 'bg-brand-50 text-brand-700')}>
      {children}
    </button>
  )
}

/** Small Tiptap editor for a single clause body. Content is simple HTML (paragraphs, lists, bold, italic). */
export function ClauseEditor({ value, onChange, editable = true }: Props) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, blockquote: false, horizontalRule: false, strike: false })],
    content: value,
    editable,
    onUpdate: ({ editor: e }) => onChange(e.getHTML())
  })

  // Keep the editor in sync when the clause is changed from outside (restore, accept suggestion).
  useEffect(() => {
    if (editor && value !== editor.getHTML()) editor.commands.setContent(value, false)
  }, [value, editor])

  useEffect(() => {
    editor?.setEditable(editable, false)
  }, [editable, editor])

  if (!editor) return null
  return (
    <div className={cn('rounded-md border', editable ? 'border-slate-300 bg-white' : 'border-transparent')}>
      {editable && (
        <div className="flex items-center gap-0.5 border-b border-slate-200 px-1.5 py-1">
          <ToolbarButton label="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered className="h-3.5 w-3.5" />
          </ToolbarButton>
          <span className="mx-1 h-4 w-px bg-slate-200" />
          <ToolbarButton label="撤销" onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="重做" onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  )
}

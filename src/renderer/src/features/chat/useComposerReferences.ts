import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  DragEvent,
  MutableRefObject,
  RefObject,
  SetStateAction
} from 'react'
import type { ImageContent } from '../../../../shared/types'
import {
  buildReferenceMessage,
  createReferenceId,
  fileToImageContent,
  readReferenceFile,
  REFERENCE_TRIGGER_RE,
  referenceToken,
  removeReferenceToken
} from './composerReferences'
import type { ReferenceAttachment } from './composerReferences'

interface UseComposerReferencesOptions {
  valueRef: MutableRefObject<string>
  setValue: Dispatch<SetStateAction<string>>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
  /** Invalidate synchronously, and report completion even when React batches the read. */
  onDraftAvailabilityChange: (available: boolean) => void
}

type ComposerReference = ReferenceAttachment & { restored?: boolean }

function autoSize(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`
}

export function useComposerReferences({
  valueRef,
  setValue,
  textareaRef,
  disabled,
  onDraftAvailabilityChange
}: UseComposerReferencesOptions) {
  const [pendingReferences, setPendingReferences] = useState<ComposerReference[]>([])
  const [referenceError, setReferenceError] = useState('')
  const [readingReferences, setReadingReferences] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const referencesRef = useRef<ComposerReference[]>([])
  const pendingReadsRef = useRef(0)
  const optionsRef = useRef({ disabled, onDraftAvailabilityChange })
  optionsRef.current = { disabled, onDraftAvailabilityChange }

  const replaceReferences = useCallback((references: ComposerReference[]): void => {
    referencesRef.current = references
    optionsRef.current.onDraftAvailabilityChange(false)
    setPendingReferences(references)
  }, [])

  const beginRead = useCallback((): void => {
    pendingReadsRef.current += 1
    optionsRef.current.onDraftAvailabilityChange(false)
    setReadingReferences(true)
  }, [])

  const finishRead = useCallback((): void => {
    pendingReadsRef.current -= 1
    setReadingReferences(pendingReadsRef.current > 0)
    optionsRef.current.onDraftAvailabilityChange(
      pendingReadsRef.current === 0 && referencesRef.current.length === 0 && valueRef.current === ''
    )
  }, [valueRef])

  // Event handlers and restoration must see changes before React commits them.
  const getReferenceDraft = useCallback(() => ({
    references: referencesRef.current,
    images: referencesRef.current.flatMap((reference) => reference.kind === 'image' ? [reference.image] : []),
    reading: pendingReadsRef.current > 0
  }), [])

  const restoreImages = useCallback((images: ImageContent[]): void => {
    replaceReferences(images.map((image, index) => ({
      id: createReferenceId(),
      kind: 'image',
      name: `恢复的图像 ${index + 1}`,
      mimeType: image.mimeType,
      size: 0,
      image: { ...image },
      restored: true
    })))
    setReferenceError('')
  }, [replaceReferences])

  const buildMessage = useCallback((text: string): string => {
    let imageIndex = 0
    const parts = referencesRef.current.flatMap((reference) => {
      if (reference.kind === 'text') return [buildReferenceMessage('', [reference])]
      imageIndex += 1
      // Undo restores bare image blocks, not new file references. Do not invent
      // labels, and retain the actual image order if more files are added later.
      return reference.restored ? [] : [`[图像 ${imageIndex}: ${reference.name}]`]
    })
    return [text, ...parts].filter(Boolean).join('\n\n')
  }, [])

  const pendingImages = useMemo(
    () => pendingReferences.flatMap((reference) => reference.kind === 'image' ? [reference.image] : []),
    [pendingReferences]
  )

  const appendImage = useCallback((image: ImageContent, name = '剪贴板图像', size = 0): void => {
    if (!image.data || !image.mimeType.toLocaleLowerCase().startsWith('image/')) {
      setReferenceError('剪贴板中没有可用的图像')
      return
    }
    replaceReferences([...referencesRef.current, {
      id: createReferenceId(),
      kind: 'image',
      name,
      mimeType: image.mimeType,
      size,
      image
    }])
    setReferenceError('')
  }, [replaceReferences])

  const addReferenceFiles = useCallback(async (files: File[], triggerValue?: string): Promise<void> => {
    if (optionsRef.current.disabled || files.length === 0) return
    beginRead()
    setReferenceError('')
    try {
      const loaded: ReferenceAttachment[] = []
      const errors: string[] = []
      for (const file of files) {
        try {
          loaded.push(await readReferenceFile(file))
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `无法读取 ${file.name}`)
        }
      }
      if (loaded.length > 0) {
        replaceReferences([...referencesRef.current, ...loaded])
        if (triggerValue && valueRef.current === triggerValue) {
          const match = triggerValue.match(REFERENCE_TRIGGER_RE)
          if (match && match.index !== undefined) {
            const start = match.index + match[1].length
            // Images show as thumbnails below the input; only text references
            // need inline tokens.
            const textReferences = loaded.filter((reference) => reference.kind === 'text')
            const replacement = textReferences.length > 0
              ? `${textReferences.map((reference) => referenceToken(reference.name)).join(' ')} `
              : ''
            const nextValue = triggerValue.slice(0, start) + replacement
            valueRef.current = nextValue
            optionsRef.current.onDraftAvailabilityChange(false)
            setValue(nextValue)
          }
        }
      }
      setReferenceError(errors.join('；'))
    } finally {
      finishRead()
    }
  }, [beginRead, finishRead, replaceReferences, setValue, valueRef])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (optionsRef.current.disabled) {
      event.preventDefault()
      return
    }
    const imageItem = Array.from(event.clipboardData.items)
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    const hasText = event.clipboardData.getData('text/plain').length > 0
    if (file) {
      event.preventDefault()
      setReferenceError('')
    }

    // Electron/Linux may expose an image through the native clipboard without
    // adding an image item to ClipboardEvent. Keep normal text paste intact and
    // count the native fallback as a pending read too.
    beginRead()
    void (async () => {
      try {
        const image = file ? await fileToImageContent(file) : await window.pion.readClipboardImage()
        if (image) appendImage(image, file?.name || '剪贴板图像', file?.size ?? 0)
      } catch (error) {
        if (file || !hasText) setReferenceError(error instanceof Error ? error.message : '无法读取剪贴板图像')
      } finally {
        finishRead()
      }
    })()
  }, [appendImage, beginRead, finishRead])

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    if (optionsRef.current.disabled) return
    const files = Array.from(event.currentTarget.files ?? [])
    const triggerValue = valueRef.current
    event.currentTarget.value = ''
    void addReferenceFiles(files, triggerValue)
  }, [addReferenceFiles, valueRef])

  const handleDrop = useCallback((event: DragEvent<HTMLTextAreaElement>): void => {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    if (optionsRef.current.disabled) return
    void addReferenceFiles(Array.from(event.dataTransfer.files), valueRef.current)
  }, [addReferenceFiles, valueRef])

  const removeReference = useCallback((id: string): void => {
    if (optionsRef.current.disabled) return
    const reference = referencesRef.current.find((item) => item.id === id)
    if (!reference) return
    if (!reference.restored) {
      const nextValue = removeReferenceToken(valueRef.current, reference.name)
      if (nextValue !== valueRef.current) {
        valueRef.current = nextValue
        optionsRef.current.onDraftAvailabilityChange(false)
        setValue(nextValue)
        requestAnimationFrame(() => {
          if (textareaRef.current) autoSize(textareaRef.current)
        })
      }
    }
    replaceReferences(referencesRef.current.filter((item) => item.id !== id))
  }, [replaceReferences, setValue, textareaRef, valueRef])

  const clearReferences = useCallback((): void => {
    replaceReferences([])
    setReferenceError('')
  }, [replaceReferences])

  const openReferencePicker = useCallback((): void => {
    if (optionsRef.current.disabled) return
    setReferenceError('')
    fileInputRef.current?.click()
  }, [])

  const insertReferenceToken = useCallback((name: string): void => {
    if (optionsRef.current.disabled) return
    const current = valueRef.current
    const match = current.match(REFERENCE_TRIGGER_RE)
    if (!match || match.index === undefined) return
    const start = match.index + match[1].length
    const nextValue = `${current.slice(0, start)}${referenceToken(name)} `
    valueRef.current = nextValue
    optionsRef.current.onDraftAvailabilityChange(false)
    setValue(nextValue)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      autoSize(element)
      element.focus()
      element.setSelectionRange(nextValue.length, nextValue.length)
    })
  }, [setValue, textareaRef, valueRef])

  return {
    pendingReferences,
    pendingImages,
    getReferenceDraft,
    restoreImages,
    buildMessage,
    referenceError,
    readingReferences,
    fileInputRef,
    addReferenceFiles,
    handlePaste,
    handleFileInputChange,
    handleDrop,
    removeReference,
    clearReferences,
    openReferencePicker,
    insertReferenceToken
  }
}

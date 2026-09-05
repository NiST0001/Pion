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
  createReferenceId,
  fileToImageContent,
  readReferenceFile,
  referenceToken,
  removeReferenceToken
} from './composerReferences'
import type { ReferenceAttachment } from './composerReferences'

interface UseComposerReferencesOptions {
  valueRef: MutableRefObject<string>
  setValue: Dispatch<SetStateAction<string>>
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

function autoSize(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`
}

export function useComposerReferences({
  valueRef,
  setValue,
  textareaRef
}: UseComposerReferencesOptions) {
  const [pendingReferences, setPendingReferences] = useState<ReferenceAttachment[]>([])
  const [referenceError, setReferenceError] = useState('')
  const [readingReferences, setReadingReferences] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pendingImages = useMemo(
    () => pendingReferences.flatMap((reference) => reference.kind === 'image' ? [reference.image] : []),
    [pendingReferences]
  )

  const appendImage = useCallback((image: ImageContent, name = '剪贴板图像', size = 0): void => {
    if (!image.data || !image.mimeType.toLocaleLowerCase().startsWith('image/')) {
      setReferenceError('剪贴板中没有可用的图像')
      return
    }
    setPendingReferences((current) => [...current, {
      id: createReferenceId(),
      kind: 'image',
      name,
      mimeType: image.mimeType,
      size,
      image
    }])
    setReferenceError('')
  }, [])

  const addReferenceFiles = useCallback(async (files: File[], triggerValue?: string): Promise<void> => {
    if (files.length === 0) return
    setReadingReferences(true)
    setReferenceError('')
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
      setPendingReferences((current) => [...current, ...loaded])
      if (triggerValue && valueRef.current === triggerValue) {
        const match = triggerValue.match(/(^|\s)@([^\s]*)$/)
        if (match && match.index !== undefined) {
          const start = match.index + match[1].length
          const replacement = `${loaded.map((reference) => referenceToken(reference.name)).join(' ')} `
          const nextValue = triggerValue.slice(0, start) + replacement
          valueRef.current = nextValue
          setValue(nextValue)
        }
      }
    }
    setReferenceError(errors.join('；'))
    setReadingReferences(false)
  }, [setValue, valueRef])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItem = Array.from(event.clipboardData.items)
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    if (file) {
      event.preventDefault()
      setReferenceError('')
      void fileToImageContent(file)
        .then((image) => appendImage(image, file.name || '剪贴板图像', file.size))
        .catch((error: unknown) => {
          setReferenceError(error instanceof Error ? error.message : '无法读取剪贴板图像')
        })
      return
    }

    // Electron/Linux may expose an image through the native clipboard without
    // adding an image item to ClipboardEvent. Keep normal text paste intact and
    // use the main-process fallback in parallel.
    const hasText = event.clipboardData.getData('text/plain').length > 0
    void window.pion.readClipboardImage()
      .then((image) => {
        if (image) appendImage(image)
      })
      .catch((error: unknown) => {
        if (!hasText) setReferenceError(error instanceof Error ? error.message : '无法读取剪贴板图像')
      })
  }, [appendImage])

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    const triggerValue = valueRef.current
    event.currentTarget.value = ''
    void addReferenceFiles(files, triggerValue)
  }, [addReferenceFiles, valueRef])

  const handleDrop = useCallback((event: DragEvent<HTMLTextAreaElement>): void => {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    void addReferenceFiles(Array.from(event.dataTransfer.files), valueRef.current)
  }, [addReferenceFiles, valueRef])

  const removeReference = useCallback((id: string): void => {
    const reference = pendingReferences.find((item) => item.id === id)
    if (reference) {
      const nextValue = removeReferenceToken(valueRef.current, reference.name)
      if (nextValue !== valueRef.current) {
        valueRef.current = nextValue
        setValue(nextValue)
        requestAnimationFrame(() => {
          if (textareaRef.current) autoSize(textareaRef.current)
        })
      }
    }
    setPendingReferences((current) => current.filter((item) => item.id !== id))
  }, [pendingReferences, setValue, textareaRef, valueRef])

  const clearReferences = useCallback((): void => {
    setPendingReferences([])
    setReferenceError('')
  }, [])

  const openReferencePicker = useCallback((): void => {
    setReferenceError('')
    fileInputRef.current?.click()
  }, [])

  const insertReferenceToken = useCallback((name: string): void => {
    const current = valueRef.current
    const match = current.match(/(^|\s)@([^\s]*)$/)
    if (!match || match.index === undefined) return
    const start = match.index + match[1].length
    const nextValue = `${current.slice(0, start)}${referenceToken(name)} `
    valueRef.current = nextValue
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

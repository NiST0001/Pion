import type { ImageContent } from '../../../../shared/types'

const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_REFERENCE_TEXT_BYTES = 1 * 1024 * 1024
const TEXT_REFERENCE_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'csharp', 'css', 'csv', 'dockerfile', 'env',
  'go', 'graphql', 'gql', 'h', 'hpp', 'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonc',
  'jsx', 'kt', 'less', 'lock', 'log', 'markdown', 'md', 'mdx', 'mjs', 'mts', 'patch', 'php',
  'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx',
  'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh'
])
const TEXT_REFERENCE_FILENAMES = new Set([
  '.editorconfig', '.env', '.gitattributes', '.gitignore', '.gitmodules', '.npmrc',
  'dockerfile', 'gemfile', 'license', 'makefile', 'procfile', 'rakefile', 'readme'
])
const IMAGE_REFERENCE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp'
}

export type ReferenceAttachment =
  | {
      id: string
      kind: 'image'
      name: string
      mimeType: string
      size: number
      image: ImageContent
    }
  | {
      id: string
      kind: 'text'
      name: string
      mimeType: string
      size: number
      content: string
    }

export function createReferenceId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function fileExtension(name: string): string {
  const normalized = name.toLocaleLowerCase()
  const dot = normalized.lastIndexOf('.')
  return dot >= 0 ? normalized.slice(dot + 1) : normalized
}

function imageMimeType(file: File): string | null {
  const mimeType = file.type.toLocaleLowerCase()
  return mimeType.startsWith('image/') ? mimeType : IMAGE_REFERENCE_MIME_TYPES[fileExtension(file.name)] ?? null
}

function isTextReferenceFile(file: File): boolean {
  const mimeType = file.type.toLocaleLowerCase()
  return mimeType.startsWith('text/')
    || ['application/json', 'application/javascript', 'application/xml', 'application/x-yaml', 'application/toml'].includes(mimeType)
    || TEXT_REFERENCE_EXTENSIONS.has(fileExtension(file.name))
    || TEXT_REFERENCE_FILENAMES.has(file.name.toLocaleLowerCase())
}

export function referenceToken(name: string): string {
  return `@${name.replace(/\s+/g, '_')}`
}

export function removeReferenceToken(message: string, name: string): string {
  const token = referenceToken(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return message
    .replace(new RegExp(`(^|\\s)${token}(?=\\s|$)`, 'g'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
}

export function buildReferenceMessage(message: string, references: ReferenceAttachment[]): string {
  const parts = references
    .filter((reference): reference is Extract<ReferenceAttachment, { kind: 'text' }> => reference.kind === 'text')
    .map((reference) => `[文件参考 ${referenceToken(reference.name)}]\n<reference-content>\n${reference.content}\n</reference-content>`)
  return [message.trim(), ...parts].filter(Boolean).join('\n\n')
}

export async function readReferenceFile(file: File): Promise<ReferenceAttachment> {
  const imageType = imageMimeType(file)
  if (imageType) {
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`图像 ${file.name} 超过 8 MB 限制`)
    return {
      id: createReferenceId(),
      kind: 'image',
      name: file.name || '图像参考',
      mimeType: imageType,
      size: file.size,
      image: await fileToImageContent(file, imageType)
    }
  }
  if (!isTextReferenceFile(file)) {
    throw new Error(`${file.name} 不是可读取的文本或图像文件`)
  }
  if (file.size > MAX_REFERENCE_TEXT_BYTES) throw new Error(`文件 ${file.name} 超过 1 MB 限制`)
  return {
    id: createReferenceId(),
    kind: 'text',
    name: file.name || '文本参考',
    mimeType: file.type || 'text/plain',
    size: file.size,
    content: await file.text()
  }
}

export function fileToImageContent(
  file: File,
  mimeType = imageMimeType(file) ?? 'image/png'
): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      reject(new Error(`图像 ${file.name} 超过 8 MB 限制`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('无法读取图像文件'))
        return
      }
      const separator = result.indexOf(',')
      if (separator < 0) {
        reject(new Error('图像文件格式无效'))
        return
      }
      const data = result.slice(separator + 1)
      if (!data) {
        reject(new Error('图像文件为空'))
        return
      }
      resolve({
        type: 'image',
        data,
        mimeType
      })
    }
    reader.onerror = () => reject(new Error('无法读取图像文件'))
    reader.readAsDataURL(file)
  })
}

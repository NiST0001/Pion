// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import type { ToolItem } from '../../src/renderer/src/agent/types'
import type { ToolInfo } from '../../src/shared/types'
import { applyToolResult, parseToolArgs } from '../../src/renderer/src/agent/timeline'
import { collectToolImages } from '../../src/shared/tool-images'
import { CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { DIFF_PAGE_SIZE } from '../../src/renderer/src/features/review/DiffView'
import { SkillsToolsModal } from '../../src/renderer/src/features/capabilities/SkillsToolsModal'

const chatCss = readFileSync(resolve('src/renderer/src/styles/chat.css'), 'utf8')
const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const imageTool: ToolItem = {
  id: 'image-call', name: IMAGE_GENERATION_TOOL_NAME, status: 'done', isError: false, live: true,
  images: collectToolImages([previewPart]).images
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const liveTool: ToolItem = {
  id: 'tool-1',
  name: 'bash',
  status: 'running',
  isError: false,
  command: 'printf output',
  outputText: 'output',
  live: true
}

describe('ToolCallItem', () => {
  it('labels the built-in question tool without requiring a plugin renderer', () => {
    render(<ToolCallItem tool={{ ...liveTool, name: 'pion_ask_user', command: undefined }} noReveal />)
    expect(screen.getByRole('button', { name: '展开提问工具详情' })).toBeInTheDocument()
  })

  it('shows the restored running label immediately even for historical noReveal rows', () => {
    const { container, rerender } = render(<ToolCallItem tool={{ ...liveTool, status: 'done', resultReceived: false }} historical noReveal />)
    expect(container).not.toHaveTextContent('执行中…')
    rerender(<ToolCallItem tool={liveTool} historical noReveal />)
    expect(container).toHaveTextContent('执行中…')
    expect(container.querySelector('.tool-icon')).toHaveClass('spin')
    rerender(<ToolCallItem tool={{ ...liveTool, status: 'done', resultReceived: true }} historical noReveal />)
    expect(container).not.toHaveTextContent('执行中…')
    expect(container.querySelector('.tool-icon')).not.toHaveClass('spin')
  })

  it('reveals live tool headers and details as streamed text arrives', () => {
    const { container } = render(<ToolCallItem tool={liveTool} />)

    const head = screen.getByRole('button', { name: '展开终端工具详情' })
    fireEvent.click(head)
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
  })

  it('animates details closed before releasing their DOM', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ToolCallItem tool={liveTool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
      expect(container.querySelector('.tool-body')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起终端工具详情' }))
      expect(container.querySelector('.animated-disclosure')).toHaveAttribute('aria-hidden', 'true')
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('.tool-body')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('releases live character spans and does not recreate them for a header-only update', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<ToolCallItem tool={liveTool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
      act(() => vi.advanceTimersByTime(300))
      const body = container.querySelector('.tool-output')
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      rerender(<ToolCallItem tool={{ ...liveTool, status: 'done' }} />)
      expect(container.querySelector('.tool-output')).toBe(body)
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      expect(body).toHaveTextContent('output')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps noReveal detail content outside character animation too', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
    expect(container.querySelector('.tool-output')).toHaveTextContent('output')
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('mounts image-only previews only while details are present and releases them after closing', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ToolCallItem tool={imageTool} noReveal />)
      expect(container.querySelector('.tool-result-images')).not.toBeInTheDocument()
      expect(container.querySelector('img')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '展开生图工具详情' })).toHaveTextContent('1 张图片')
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const image = screen.getByRole('img', { name: '工具结果预览 1' })
      expect(image).toHaveAttribute('src', `data:image/png;base64,${previewPart.data}`)
      expect(image).toHaveAttribute('width', '1')
      expect(image).toHaveAttribute('height', '1')
      expect(container.querySelector('.tool-empty')).not.toBeInTheDocument()
      expect(container.querySelector('.tool-output')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      expect(container.querySelector('img')).toBe(image)
      expect(container.querySelector('.animated-disclosure')).toHaveAttribute('inert')
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('img')).not.toBeInTheDocument()
      expect(container.querySelector('.tool-result-images')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it.each([
    { metadata: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS }, label: 'Codex 自动（官方别名）' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' }, label: 'Images 2.5 Flare（实验性）' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-sunburst' }, label: 'Images 2.5 Sunburst（实验性）' },
    { metadata: { version: 1, provider: 'openai-codex', model: 'unknown-sensitive-string' }, label: '未知请求型号' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-string' }, label: '未知请求型号' },
    { metadata: { version: 99, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' }, label: '未知请求型号' },
    { metadata: {}, label: '未知请求型号' }
  ])('shows only a short historical request label, never an actual engine claim: $label', ({ metadata, label }) => {
    const tool = applyToolResult({ ...imageTool, images: undefined, ...parseToolArgs(imageTool.name, {}) }, {
      content: [previewPart], details: { imageGeneration: { ...metadata,
        path: 'images/saved.png', resolvedModel: 'untrusted-actual-echo' } }
    }, false, 'history')
    const { container } = render(<ToolCallItem tool={tool} historical noReveal />)
    expect(container.querySelector('.tool-image-model-info')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText(`请求型号：${label}`)).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('unknown-sensitive-string')
    expect(container).not.toHaveTextContent('untrusted-actual-echo')
    expect(container).not.toHaveTextContent('已确认')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/saved.png')
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${previewPart.data}`)
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('previews the default request alias while running and does not show image model fields for other tools', () => {
    const requested = { ...imageTool, status: 'running' as const, images: undefined,
      ...parseToolArgs(imageTool.name, {}) }
    const { container, rerender } = render(<ToolCallItem tool={requested} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('请求型号：Codex 自动（官方别名）')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    rerender(<ToolCallItem tool={{ ...requested, name: 'read', status: 'done' }} noReveal />)
    expect(container.querySelector('.tool-image-model-info')).not.toBeInTheDocument()
  })

  it('keeps loaded preview DOM and a single decode when final request model and output fields change', () => {
    const decode = vi.spyOn(globalThis, 'atob')
    const payload = { content: [{ type: 'text', text: '已保存' }, previewPart], details: {
      imageGeneration: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
        path: 'images/saved.png' }
    } }
    const first = applyToolResult({ ...imageTool, images: undefined }, payload, false)
    const { container, rerender } = render(<ToolCallItem tool={first} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const image = screen.getByRole('img')
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    fireEvent.load(image)
    const second = applyToolResult(first, { ...payload, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
      resolvedModel: 'untrusted-actual-echo', path: 'images/saved.png'
    } } }, false, 'message')
    expect(second.images).toBe(first.images)
    rerender(<ToolCallItem tool={second} noReveal />)
    expect(screen.getByText('请求型号：Images 2.5 Flare（实验性）')).toBeInTheDocument()
    const third = applyToolResult(second, { ...payload,
      content: [{ type: 'text', text: 'final warning' }, previewPart],
      details: { imageGeneration: { version: 2, provider: 'openai-codex',
        requestedModel: 'gpt-image-2.5-sunburst', path: 'images/final.png' } }
    }, true, 'message')
    expect(third.images).toBe(first.images)
    rerender(<ToolCallItem tool={third} noReveal />)
    expect(screen.getByText('请求型号：Images 2.5 Sunburst（实验性）')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container.querySelector('.tool-output')).toHaveTextContent('final warning')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/final.png')
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(screen.getByRole('img')).toBe(image)
    expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('shows explicit request settings and saved original dimensions separately from the bounded preview', () => {
    const requested: ToolItem = { ...imageTool, images: undefined, status: 'running', ...parseToolArgs(imageTool.name, {
      size: '2048x3072', quality: 'high', referenced_image_paths: ['images/private-source.png']
    }) }
    const { container, rerender } = render(<ToolCallItem tool={requested} historical noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('操作请求：编辑')).toBeInTheDocument()
    expect(screen.getByText('请求尺寸：2048x3072')).toBeInTheDocument()
    expect(screen.getByText('请求质量：high')).toBeInTheDocument()
    expect(screen.getByText('参考图数量：1')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('原图保存尺寸')
    expect(container.querySelector('img')).not.toBeInTheDocument()
    const saved = applyToolResult(requested, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high', referenceCount: 1,
      path: 'images/edited.png', width: 1024, height: 1536, byteLength: 100_000,
      actualSize: '4096x4096', actualQuality: 'untrusted-quality-echo', resolvedModel: 'untrusted-engine-echo',
      referenced_image_paths: ['images/private-source.png'], referenceBytes: 'private-original-bytes'
    } } }, false, 'history')
    rerender(<ToolCallItem tool={saved} historical noReveal />)
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByText('缩略图预览：每边最多 512 px')).toBeInTheDocument()
    expect(container.querySelector('figcaption')).toHaveTextContent('1 × 1 · 预览')
    expect(screen.getByRole('img')).toHaveAttribute('width', '1')
    expect(screen.getByRole('img')).toHaveAttribute('height', '1')
    expect(container).not.toHaveTextContent('4096x4096')
    expect(container).not.toHaveTextContent('untrusted')
    expect(container).not.toHaveTextContent('private-source')
    expect(container).not.toHaveTextContent('private-original-bytes')
    expect(container).not.toHaveTextContent('实际质量')
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    rerender(<ToolCallItem tool={{ ...saved, name: 'read' }} historical noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
  })

  it.each([
    { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 99, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 2, provider: 'unknown-provider', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    {}
  ])('does not invent auto settings or reference counts for old/unknown final metadata: %j', (metadata) => {
    const saved = applyToolResult({ ...imageTool, images: undefined, ...parseToolArgs(imageTool.name, {
      size: 'auto', quality: 'auto', referenced_image_paths: []
    }) }, { content: [previewPart], details: { imageGeneration: metadata } }, false, 'history')
    const { container } = render(<ToolCallItem tool={saved} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('请求尺寸')
    expect(container).not.toHaveTextContent('请求质量')
    expect(container).not.toHaveTextContent('操作请求')
    expect(container).not.toHaveTextContent('参考图数量')
    expect(container).not.toHaveTextContent('原图保存尺寸')
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('displays only independently validated settings without echoing arbitrary fields or unsupported values', () => {
    const saved = applyToolResult(imageTool, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-model',
      operation: 'unknown-sensitive-operation', requestedSize: 'unknown-sensitive-size',
      requestedQuality: 'medium', referenceCount: 7, width: 1024, height: 1536,
      byteLength: 'unknown-sensitive-byteLength', sourcePaths: ['images/private-source.png'],
      actualQuality: 'unknown-sensitive-quality', mask: 'images/private-mask.png'
    } } }, false)
    const { container } = render(<ToolCallItem tool={saved} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('请求质量：medium')).toBeInTheDocument()
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByText('请求型号：未知请求型号')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('unknown-sensitive')
    expect(container).not.toHaveTextContent('private-source')
    expect(container).not.toHaveTextContent('private-mask')
    expect(container).not.toHaveTextContent('操作请求')
    expect(container).not.toHaveTextContent('请求尺寸')
    expect(container).not.toHaveTextContent('参考图数量')
    expect(container).not.toHaveTextContent('实际质量')
  })

  it.each(['loaded', 'failed'] as const)('keeps a %s preview frame, DOM and decode stable through settings-only replacements/removals', (state) => {
    const decode = vi.spyOn(globalThis, 'atob')
    const metadata = { version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      operation: 'generate', requestedSize: 'auto', requestedQuality: 'low', referenceCount: 0,
      path: 'images/saved.png', width: 1024, height: 1024, byteLength: 100_000 }
    const payload = { content: [previewPart], details: { imageGeneration: metadata } }
    const first = applyToolResult({ ...imageTool, images: undefined }, payload, false)
    const { container, rerender } = render(<ToolCallItem tool={first} noReveal />)
    container.scrollTop = 75
    const onScroll = vi.fn()
    container.addEventListener('scroll', onScroll)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const image = screen.getByRole('img')
    const frame = image.parentElement!
    const caption = container.querySelector('figcaption')
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    if (state === 'loaded') fireEvent.load(image)
    else fireEvent.error(image)
    const second = applyToolResult(first, { ...payload, details: { imageGeneration: {
      ...metadata, operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high',
      referenceCount: 2, width: 1024, height: 1536, byteLength: 120_000
    } } }, false, 'message')
    expect(second.images).toBe(first.images)
    rerender(<ToolCallItem tool={second} noReveal />)
    expect(screen.getByText('请求质量：high')).toBeInTheDocument()
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
    expect(container.querySelector('figcaption')).toBe(caption)
    expect(frame).toHaveAttribute('data-image-state', state)
    if (state === 'loaded') expect(screen.getByRole('img')).toBe(image)
    else expect(container.querySelector('img')).not.toBeInTheDocument()
    const third = applyToolResult(second, { ...payload, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/saved.png'
    } } }, false, 'message')
    expect(third.images).toBe(first.images)
    rerender(<ToolCallItem tool={third} noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
    expect(frame).toHaveAttribute('data-image-state', state)
    expect(container.querySelector('figcaption')).toBe(caption)
    if (state === 'loaded') expect(screen.getByRole('img')).toBe(image)
    expect(container.scrollTop).toBe(75)
    expect(onScroll).not.toHaveBeenCalled()
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('releases image settings together with preview details after closing', () => {
    vi.useFakeTimers()
    try {
      const saved = applyToolResult(imageTool, { content: [previewPart], details: { imageGeneration: {
        version: 2, provider: 'openai-codex', operation: 'generate', requestedSize: 'auto',
        requestedQuality: 'auto', referenceCount: 0, width: 1024, height: 1536
      } } }, false)
      const { container } = render(<ToolCallItem tool={saved} noReveal />)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      expect(screen.getByText('操作请求：生成')).toBeInTheDocument()
      expect(screen.getByText('参考图数量：0')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
      expect(container.querySelector('img')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps images out of character reveal while preserving mixed-result text animation', () => {
    const { container, rerender } = render(<ToolCallItem tool={{ ...imageTool, outputText: 'output' }} />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    const image = screen.getByRole('img')
    expect(container.querySelector('.tool-output [data-screen-reveal-character]')).toBeInTheDocument()
    expect(gallery.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    fireEvent.load(image)
    rerender(<ToolCallItem tool={{ ...imageTool, outputText: 'output', path: 'images/result.png' }} />)
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(screen.getByRole('img')).toBe(image)
    expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/result.png')
  })

  it('preserves loaded image nodes on part reordering and quick disclosure reversal', () => {
    vi.useFakeTimers()
    try {
      const images = collectToolImages([previewPart, { type: 'text', text: 'between' }, previewPart]).images
      const { container, rerender } = render(<ToolCallItem tool={{ ...imageTool, images }} noReveal />)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const original = Array.from(container.querySelectorAll('img'))
      fireEvent.load(original[0])
      rerender(<ToolCallItem tool={{ ...imageTool, images: [...images].reverse() }} noReveal />)
      expect(Array.from(container.querySelectorAll('img'))).toEqual([original[1], original[0]])
      expect(original[0].parentElement).toHaveAttribute('data-image-state', 'loaded')
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      act(() => vi.advanceTimersByTime(80))
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      act(() => vi.advanceTimersByTime(220))
      expect(Array.from(container.querySelectorAll('img'))).toEqual([original[1], original[0]])
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('retains a fixed frame on load and failure without scrolling the conversation', () => {
    const style = document.createElement('style')
    style.textContent = chatCss
    document.head.append(style)
    try {
      const { container, rerender } = render(<ToolCallItem tool={imageTool} noReveal />)
      container.scrollTop = 75
      const onScroll = vi.fn()
      container.addEventListener('scroll', onScroll)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const image = screen.getByRole('img')
      const frame = image.parentElement!
      const caption = container.querySelector('figcaption')
      expect(getComputedStyle(frame).height).toBe('200px')
      expect(getComputedStyle(image).objectFit).toBe('contain')
      fireEvent.load(image)
      expect(frame).toHaveAttribute('data-image-state', 'loaded')
      expect(getComputedStyle(frame).height).toBe('200px')
      fireEvent.error(image)
      expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
      expect(frame).toHaveAttribute('data-image-state', 'failed')
      expect(getComputedStyle(frame).height).toBe('200px')
      expect(frame).toHaveTextContent('预览加载失败，请查看工具输出中的原图路径。')
      expect(container.querySelector('figcaption')).toBe(caption)
      expect(container.scrollTop).toBe(75)
      expect(onScroll).not.toHaveBeenCalled()
      // A header rerender must not turn a failed frame back into a new decode.
      rerender(<ToolCallItem tool={{ ...imageTool, path: 'images/result.png' }} noReveal />)
      expect(frame).toHaveAttribute('data-image-state', 'failed')
    } finally { style.remove() }
  })

  it('displays rejected-image notices without a false empty result or character animation', () => {
    const result = collectToolImages([{ ...previewPart, data: 'not-base64!' }])
    const { container } = render(<ToolCallItem tool={{ ...imageTool, images: result.images, imageNotice: result.notice }} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    expect(gallery).toHaveTextContent('部分图片因格式或大小限制未显示。')
    expect(gallery.querySelector('img')).not.toBeInTheDocument()
    expect(container.querySelector('.tool-empty')).not.toBeInTheDocument()
    expect(gallery.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('immediately releases previews with reduced motion and keeps noReveal image details static', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<ToolCallItem tool={imageTool} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
    expect(container.querySelector('img')).not.toBeInTheDocument()
    const css = chatCss
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.tool-result-image-frame\s*\{[^}]*border-color: CanvasText;[^}]*background: Canvas;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tool-result-images,[\s\S]*?animation: none;/)
    expect(css).toMatch(/\.tool-image-model-info,\s*\.tool-image-settings-info\s*\{[^}]*color: CanvasText;/)
  })

  it('preserves bounded diff paging alongside previews and header updates', () => {
    const diff = Array.from({ length: DIFF_PAGE_SIZE + 2 }, (_, index) => `+${index + 1} line-${index + 1}`).join('\n')
    const tool = { ...imageTool, name: 'edit', diff }
    const { container, rerender } = render(<ToolCallItem tool={tool} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开编辑工具详情' }))
    expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
    const image = screen.getByRole('img')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    rerender(<ToolCallItem tool={{ ...tool, path: 'new.ts' }} noReveal />)
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    expect(screen.getByRole('img')).toBe(image)
  })

  it('advertises the built-in Codex image tool with its login, quota and mode requirements', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [] }) })
    render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    expect(screen.getByText(IMAGE_GENERATION_TOOL_NAME)).toBeInTheDocument()
    const card = screen.getByText('Codex 生图').closest('article')
    expect(card).toHaveTextContent('Pion 内置')
    expect(card).toHaveTextContent('单张 PNG')
    expect(card).toHaveTextContent('需要 Codex 登录和账号额度')
    expect(card).toHaveTextContent('计划模式不可用')
    expect(card).toHaveTextContent('默认请求 Codex 自动（官方别名）')
    expect(card).toHaveTextContent('使用 2.5 Flare 生图')
    expect(card).toHaveTextContent('使用 2.5 Sunburst 生图')
    expect(card).toHaveTextContent('实验性请求型号')
    expect(card).toHaveTextContent('订阅兼容性未验证')
    expect(card).toHaveTextContent('不会自动降级')
    expect(card).toHaveTextContent('可通过消息指定 size（如 2048x3072）')
    expect(card).toHaveTextContent('quality（auto/low/medium/high）')
    expect(card).toHaveTextContent('referenced_image_paths')
    expect(card).toHaveTextContent('至多 5 张项目相对 PNG/JPEG')
    expect(card).toHaveTextContent('参考 images/source.png，high 质量，另存 images/edited.png')
    expect(card).toHaveTextContent('参考图连同文件元数据上传')
    expect(card).toHaveTextContent('需要 read + network + write 权限')
    expect(card).toHaveTextContent('编辑服务兼容性未验证')
    expect(card).toHaveTextContent('不保证服务接受请求尺寸或精确输出')
    expect(card).toHaveTextContent('暂不支持 mask')
    expect(card?.querySelector('input, select, [role="combobox"]')).toBeNull()
    expect(card).not.toHaveTextContent('免费')
  })

  it('shows native capabilities only from the actual builtin registration and does not claim MCP readiness', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
      { name: 'codemode', label: 'Native code', description: 'Execute JavaScript', source: 'builtin' },
      { name: 'tool_search', label: 'Native search', description: 'Search tools', source: 'builtin' },
      { name: 'mcp__server__read', label: 'MCP read', description: 'Read remote resource', source: 'builtin' }
    ] }) })
    render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const code = screen.getByText('Native code').closest('article')
    expect(code).toHaveTextContent('Pi 原生')
    expect(code).toHaveTextContent('models 模型目录')
    expect(code).toHaveTextContent('classifier / image')
    expect(code).toHaveTextContent('可能产生提供商费用')
    expect(code).toHaveTextContent('计划模式禁用')
    expect(code).not.toHaveTextContent('已安装插件')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('全局和受信任项目')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('stdio / HTTP')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('MCP 页查看原生状态，/mcp 为文本状态')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).not.toHaveTextContent('/mcp status')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('login、logout、reconnect')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('配置不会自动迁移，插件不会自动卸载')
    expect(screen.getByText('MCP read').closest('article')).not.toHaveTextContent(/ready|已连接/)
    expect(code?.querySelector('button, input, select')).toBeNull()
  })

  it('keeps built-ins before native and plugin cards with their existing label, source and description fallbacks', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
      { name: 'codemode', label: 'Plugin code', description: 'Plugin-only description', source: 'npm:example-plugin' },
      { name: 'native_empty', source: 'builtin' },
      { name: 'plugin_empty', label: '', description: '', source: 'auto' },
      { name: 'tool_search', label: '', description: '', source: 'builtin' },
      { name: 'codemode', label: 'Native code', description: 'Execute JavaScript', source: 'builtin' },
      { name: 'unowned_plugin' }
    ] }) })
    const { container } = render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const cards = Array.from(container.querySelectorAll('.capability-card-tool'))
    expect(cards.map((card) => card.querySelector('code')?.textContent)).toEqual([
      'read', 'write', 'edit', 'bash', 'pion_task', 'pion_ask_user', IMAGE_GENERATION_TOOL_NAME, 'pion_subagents',
      'native_empty', 'tool_search', 'codemode', 'codemode', 'plugin_empty', 'unowned_plugin'
    ])
    expect(cards.map((card) => card.querySelector('.capability-card-source')?.textContent)).toEqual([
      'Pi 内置', 'Pi 内置', 'Pi 内置', 'Pi 内置', 'Pion 内置', 'Pion 内置', 'Pion 内置', 'Pion 内置',
      'Pi 原生', 'Pi 原生', 'Pi 原生', 'example-plugin', '自动发现', undefined
    ])
    expect(screen.getByText('14 项工具')).toBeInTheDocument()
    expect(cards[8].querySelector('strong')).toHaveTextContent('native_empty')
    expect(cards[8].querySelector('p')).toHaveTextContent('运行时已注册的原生工具；连接与可执行状态以会话为准。')
    expect(cards[9].querySelector('strong')).toHaveTextContent('tool_search')
    expect(cards[9].querySelector('p')).toHaveTextContent('原生延迟工具检索；使用 query 搜索、limit 限制结果数。')
    expect(cards[10].querySelector('p')).toHaveTextContent(/^Execute JavaScript 原生 JavaScript 工具编排/)
    expect(cards[11].querySelector('p')).toHaveTextContent('Plugin-only description')
    expect(cards[12].querySelector('strong')).toHaveTextContent('plugin_empty')
    expect(cards[12].querySelector('p')).toHaveTextContent('已安装插件提供的工具。')
    expect(cards[13].querySelector('strong')).toHaveTextContent('unowned_plugin')
    expect(cards[13].querySelector('p')).toHaveTextContent('已安装插件提供的工具。')
    for (const card of cards.slice(8)) expect(card.querySelector('.capability-card-icon svg')).toHaveClass('lucide-wrench')
  })

  it('preserves separate native and plugin-source card nodes when same-name tools reorder or disappear', async () => {
    const alpha: ToolInfo = { name: 'codemode', label: 'Plugin alpha', source: 'npm:alpha' }
    const native: ToolInfo = { name: 'codemode', label: 'Native code', source: 'builtin' }
    const beta: ToolInfo = { name: 'codemode', label: 'Plugin beta', source: 'npm:beta' }
    const tools = [alpha, native, beta]
    const getCapabilities = vi.fn().mockResolvedValue({ skills: [], tools })
    vi.stubGlobal('pion', { getCapabilities })
    const { container, rerender } = render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const builtinCard = screen.getByText('读取文件').closest('article')
    const nativeCard = screen.getByText('Native code').closest('article')
    const alphaCard = screen.getByText('Plugin alpha').closest('article')
    const betaCard = screen.getByText('Plugin beta').closest('article')
    expect(new Set([nativeCard, alphaCard, betaCard]).size).toBe(3)
    expect(alphaCard).toHaveTextContent('alpha')
    expect(betaCard).toHaveTextContent('beta')
    // Update only the in-memory loader fixture; reopening would remount the page
    // and could not verify the cards' key-based reconciliation.
    tools.splice(0, tools.length, beta, native, alpha)
    rerender(<SkillsToolsModal open onClose={vi.fn()} />)
    expect(Array.from(container.querySelectorAll('.capability-card-tool')).slice(8)).toEqual([
      nativeCard, betaCard, alphaCard
    ])
    expect(screen.getByText('读取文件').closest('article')).toBe(builtinCard)
    expect(screen.getByText('Native code').closest('article')).toBe(nativeCard)
    expect(screen.getByText('Plugin alpha').closest('article')).toBe(alphaCard)
    expect(screen.getByText('Plugin beta').closest('article')).toBe(betaCard)
    const replacement: ToolInfo = { ...beta, source: 'npm:gamma' }
    tools.splice(0, tools.length, replacement, native)
    rerender(<SkillsToolsModal open onClose={vi.fn()} />)
    expect(screen.getByText('Plugin beta').closest('article')).not.toBe(betaCard)
    expect(screen.getByText('Plugin beta').closest('article')).toHaveTextContent('gamma')
    expect(screen.getByText('Native code').closest('article')).toBe(nativeCard)
    expect(screen.getByText('读取文件').closest('article')).toBe(builtinCard)
    expect(screen.queryByText('Plugin alpha')).not.toBeInTheDocument()
    expect(alphaCard).not.toBeInTheDocument()
    expect(betaCard).not.toBeInTheDocument()
    expect(getCapabilities).toHaveBeenCalledTimes(1)
  })

  it.each(['codemode', 'mcp', 'tool_search', 'mcp__server__read'])(
    'does not advertise absent native capabilities or relabel same-name plugin tools as native: %s', async (name) => {
      vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
        { name, label: 'Plugin tool', description: 'Plugin supplied tool', source: 'npm:example-plugin' }
      ] }) })
      render(<SkillsToolsModal open onClose={vi.fn()} />)
      await act(async () => undefined)
      fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
      const plugin = screen.getByText('Plugin tool').closest('article')
      expect(plugin).toHaveTextContent('example-plugin')
      expect(plugin).toHaveTextContent('Plugin supplied tool')
      expect(plugin).not.toHaveTextContent('Pi 原生')
      expect(plugin).not.toHaveTextContent('models 模型目录')
      expect(plugin).not.toHaveTextContent('原生延迟工具检索')
      expect(screen.queryByText(/Pi 原生 MCP 使用 mcp.json/)).not.toBeInTheDocument()
      expect(screen.queryAllByText('tool_search')).toHaveLength(name === 'tool_search' ? 1 : 0)
    }
  )

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})

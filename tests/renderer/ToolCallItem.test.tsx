// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import type { ToolItem } from '../../src/renderer/src/agent/types'
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

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { splitParagraphs, joinParagraphs, toLocal, toBody, paragraphAt } from './editor.js'

describe('splitParagraphs', () => {
  it('splits on blank lines and keeps separators lossless', () => {
    const body = 'Hi Anna,\n\nSecond para\nwith a soft break.\n\n\nThird.'
    const paras = splitParagraphs(body)
    expect(paras.map(p => p.text)).toEqual(['Hi Anna,', 'Second para\nwith a soft break.', 'Third.'])
    expect(paras.map(p => p.sep)).toEqual(['\n\n', '\n\n\n', ''])
    expect(joinParagraphs(paras)).toBe(body)
  })

  it('records body offsets', () => {
    const body = 'ab\n\ncd'
    const paras = splitParagraphs(body)
    expect(paras[0]).toMatchObject({ start: 0, end: 2 })
    expect(paras[1]).toMatchObject({ start: 4, end: 6 })
  })

  it('handles an empty body as one empty paragraph', () => {
    const paras = splitParagraphs('')
    expect(paras).toHaveLength(1)
    expect(paras[0]).toMatchObject({ text: '', start: 0, end: 0, sep: '' })
  })

  it('single newlines do not split paragraphs', () => {
    expect(splitParagraphs('a\nb')).toHaveLength(1)
  })

  it('handles leading and trailing separators', () => {
    const body = '\n\nmiddle\n\n'
    const paras = splitParagraphs(body)
    expect(paras.map(p => p.text)).toEqual(['', 'middle', ''])
    expect(joinParagraphs(paras)).toBe(body)
  })
})

describe('caret offset mapping', () => {
  const body = 'Hi Anna,\n\nSecond paragraph.\n\nBye.'
  const paras = splitParagraphs(body)

  it('maps body offsets to paragraph-local positions', () => {
    expect(toLocal(paras, 0)).toEqual({ index: 0, local: 0 })
    expect(toLocal(paras, 8)).toEqual({ index: 0, local: 8 })       // end of para 0
    expect(toLocal(paras, 10)).toEqual({ index: 1, local: 0 })      // start of para 1
    expect(toLocal(paras, 17)).toEqual({ index: 1, local: 7 })
    expect(toLocal(paras, body.length)).toEqual({ index: 2, local: 4 })
  })

  it('clamps separator-interior offsets to the previous paragraph end', () => {
    expect(toLocal(paras, 9)).toEqual({ index: 0, local: 8 })
  })

  it('clamps out-of-range offsets', () => {
    expect(toLocal(paras, -5)).toEqual({ index: 0, local: 0 })
    expect(toLocal(paras, 9999)).toEqual({ index: 2, local: 4 })
  })

  it('round-trips every in-paragraph offset', () => {
    for (const p of paras) {
      for (let off = p.start; off <= p.end; off++) {
        const { index, local } = toLocal(paras, off)
        expect(toBody(paras, index, local)).toBe(off)
      }
    }
  })

  it('toBody clamps local overflow to the paragraph end', () => {
    expect(toBody(paras, 0, 99)).toBe(8)
    expect(toBody(paras, 5, 0)).toBe(paras[2].start)
  })

  it('paragraphAt agrees with toLocal', () => {
    expect(paragraphAt(paras, 0)).toBe(0)
    expect(paragraphAt(paras, 12)).toBe(1)
    expect(paragraphAt(paras, body.length)).toBe(2)
  })
})

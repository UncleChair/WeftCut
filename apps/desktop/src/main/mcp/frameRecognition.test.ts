import { describe, expect, it } from 'vitest'
import { buildJoyAiRequest, extractAssistantText } from './frameRecognition'

const config = {
  apiBase: 'http://127.0.0.1:8070/v1',
  apiKey: 'EMPTY',
  model: 'joy-test-vl',
  sessionId: 'test-session',
  maxTokens: 128,
  temperature: 0.2,
  timeoutMs: 1000,
}

describe('frameRecognition JoyAI request', () => {
  it('mirrors JoyAI VLMService chat-completions image_url payload shape', () => {
    const req = buildJoyAiRequest(config, 'what is visible?', '1.250s', 'data:image/jpeg;base64,abc')

    expect(req.endpoint).toBe('http://127.0.0.1:8070/v1/chat/completions')
    expect(req.body).toMatchObject({
      model: 'joy-test-vl',
      max_tokens: 128,
      temperature: 0.2,
      frame_time_range: '1.250s',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is visible?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
          ],
        },
      ],
    })
  })

  it('extracts assistant text from OpenAI-compatible responses', () => {
    expect(
      extractAssistantText({
        choices: [{ message: { content: [{ type: 'text', text: 'A person enters the frame.' }] } }],
      }),
    ).toBe('A person enters the frame.')
  })
})

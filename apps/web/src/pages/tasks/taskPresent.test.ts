import { describe, expect, it } from 'vitest';
import { makeTask } from '../../test/fixtures.js';
import { taskStatusLabel, uploadProgressLabel } from './taskPresent.js';

describe('taskPresent', () => {
  it('把未收到分片的上传任务称为等待开始，而不是上传中', () => {
    const waiting = makeTask({
      currentStep: 'upload',
      status: 'running',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    expect(taskStatusLabel(waiting)).toBe('等待开始');
    expect(uploadProgressLabel(waiting)).toBe('等待开始');
  });

  it('有分片后称为上传中，进入提取后称为提取中', () => {
    const uploading = makeTask({
      upload: {
        status: 'pending',
        partsExpected: 8,
        partsLanded: 1,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    const extracting = makeTask({ currentStep: 'extract' });
    expect(taskStatusLabel(uploading)).toBe('上传中');
    expect(uploadProgressLabel(uploading)).toBe('已收 1 / 8 片');
    expect(taskStatusLabel(extracting)).toBe('提取中');
  });
});

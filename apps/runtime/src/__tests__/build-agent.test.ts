// 系统提示词编排自检：作者 instructions 逐字在前，平台注入段带服务端日期与证据纪律（issue #19）。
import { describe, expect, it } from 'vitest';
import type { CapabilityDefinition } from '@cb/shared';
import { composeKnowledgeSystemPrompt, composeSystemPrompt } from '../modules/agent/build-agent.js';

const DEFINITION: CapabilityDefinition = {
  version: 1,
  name: '文档一致性核查',
  summary: '对照文档与代码找出不一致',
  kind: '分析',
  instructions: '你是文档一致性核查助手。逐条对照文档声明与代码实现。',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

describe('composeSystemPrompt', () => {
  it('作者 instructions 逐字开头，能力名称与简介在平台注入段里', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-06T08:00:00Z'));
    expect(prompt.startsWith('你是文档一致性核查助手。')).toBe(true);
    expect(prompt).toContain('名称：文档一致性核查');
    expect(prompt).toContain('简介：对照文档与代码找出不一致');
  });

  it('注入服务端日期：产物写日期以它为准，不靠模型记忆推断', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-06T08:00:00Z'));
    expect(prompt).toContain('今天的日期是 2026-07-06');
  });

  it('注入证据纪律：材料未覆盖的事实不得当作已证实', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-06T08:00:00Z'));
    expect(prompt).toContain('# 事实纪律');
    expect(prompt).toContain('当前材料未覆盖，需要补充确认');
    expect(prompt).toContain('材料直接证明的结论');
  });

  it('缺省用当下时间：不传 now 也能生成含日期的提示词', () => {
    const prompt = composeSystemPrompt(DEFINITION);
    expect(prompt).toMatch(/今天的日期是 \d{4}-\d{2}-\d{2}/);
  });

  it('Studio 模式只负责修改 Miniapp，并以成功轮的不可变 revision 更新当前 UI', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-23T08:00:00Z'), 'studio', {
      taskText: '请生成首版 Miniapp',
      hasExistingPage: false,
    });
    expect(prompt).toContain('# Miniapp 设计模式');
    expect(prompt).toContain('不要把本轮当成一次业务任务执行');
    expect(prompt).toContain('新的不可变 revision');
    expect(prompt).toContain('不要传旧 artifactId');
    expect(prompt).toContain('本轮最后一个合法 revision');
    expect(prompt).toContain('完整自包含 HTML');
    expect(prompt).toContain('<!doctype html>');
    expect(prompt).toContain("type: 'combo:run'");
    expect(prompt).toContain('data-combo-key="run-primary"');
    expect(prompt).toContain("type: 'combo:run-state'");
    expect(prompt).toContain('只有收到 state=completed 才能宣告完成');
    expect(prompt).toContain('禁止使用 setTimeout、setInterval、Math.random');
    expect(prompt).toContain('没有成功调用 upsert_artifact 就不能声称页面已生成');
    expect(prompt).toContain('Combo Design Agent');
    expect(prompt).toContain('# 本轮 Artifact 视觉合同');
  });

  it('已有 Studio 页面时按本轮文本保持视觉连续性，不重新选择首版 Profile', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-23T08:00:00Z'), 'studio', {
      taskText: '只调整主按钮文案',
      hasExistingPage: true,
    });

    expect(prompt).toContain('# 视觉连续性（普通 Revision）');
    expect(prompt).not.toContain('# 本轮 Artifact 视觉合同');
  });

  it('普通运行会话不注入 Miniapp 设计约束', () => {
    const prompt = composeSystemPrompt(DEFINITION, new Date('2026-07-23T08:00:00Z'), 'consume');
    expect(prompt).not.toContain('# Miniapp 设计模式');
  });

  it('知识回答要求逐句直接复用证据并提供实质信息', () => {
    const prompt = composeKnowledgeSystemPrompt(
      {
        name: '公开知识助手',
        description: '只依据固定知识回答',
        instructions: '先检索，再提交。',
        requiresGroundedExtractiveAnswer: true,
      },
      new Date('2026-07-06T08:00:00Z'),
    );
    expect(prompt).toContain('每个事实性句子必须逐字复用被引用 excerpt 中的完整原句');
    expect(prompt).toContain('不得删改其中的限定、关系、否定、条件、数额、日期或版本');
    expect(prompt).toContain('每句必须有陈述式终止标点及主题之外的明确谓语或事实增量');
    expect(prompt).toContain('FAQ 问句、Markdown 标题/列表、名词型片段');
    expect(prompt).toContain('问题原样复述、短动作嵌入另一个词');
    expect(prompt).toContain('单字母、短数字、单个年份');
    expect(prompt).toContain('API/HTTP/HTTPS token');
    expect(prompt).toContain('当前中文 Beta 不做自由语义改写或前提纠正');
    expect(prompt).toContain('关系、否定、条件、时间与限定必须直接对齐');
    expect(prompt).toContain('不完整的前置上下文分句必须与后续疑问分句组成同一连通骨架');
    expect(prompt).toContain('每个连通骨架必须完整出现在同一个答案逗号分句内');
    expect(prompt).toContain('短动作与其直接宾语之间可以原位插入一个格式明确的数量值');
  });

  it('v1 固定 oracle 不注入 v2 整句抽取合同', () => {
    const prompt = composeKnowledgeSystemPrompt({
      name: '兼容知识助手',
      description: '执行平台固定用例',
      instructions: '先检索，再提交。',
      requiresGroundedExtractiveAnswer: false,
    });
    expect(prompt).not.toContain('完整原句');
    expect(prompt).not.toContain('连通骨架');
  });
});

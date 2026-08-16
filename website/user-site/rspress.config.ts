import { defineConfig } from '@rspress/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const chineseSidebar = [
  {
    text: '认识 lorebit',
    items: [
      { text: 'lorebit 是什么', link: '/' },
      { text: '选择一个值得交给知识流程的问题', link: '/start/choose-a-problem' },
      { text: '定义知识空间与回答合同', link: '/start/define-knowledge-space' }
    ]
  },
  {
    text: '建立第一条知识工作流',
    items: [
      { text: '建立第一条知识工作流', link: '/start/first-plan' },
      { text: '接入与审阅资料', link: '/start/source-and-evidence' },
      { text: '让资料进入可回答状态', link: '/guide/ingest-and-review' },
      { text: '交付带证据的回答', link: '/guide/answer-with-evidence' },
      { text: '检索与上下文', link: '/concepts/rag-pipeline' },
      { text: '理解知识、证据与引用', link: '/concepts/knowledge-model' }
    ]
  },
  {
    text: '让知识持续可靠',
    items: [
      { text: '处理资料更新、替代与撤回', link: '/guide/handle-change' },
      { text: '知识生命周期', link: '/concepts/knowledge-lifecycle' },
      { text: '按能力协商适配器', link: '/adapters/database-adapters' },
      { text: '诊断质量与恢复', link: '/guide/quality-and-recovery' },
      { text: '在进入实现前评审一条知识工作流', link: '/guide/review-a-workflow' }
    ]
  },
  {
    text: '参考',
    items: [
      { text: '0.x 目标行为合同', link: '/reference/behavior-contract' },
      { text: '用户场景验收', link: '/reference/acceptance-scenarios' },
      { text: '术语表', link: '/reference/glossary' },
      { text: '当前可用性', link: '/reference/preview-status' },
      { text: '路线图', link: '/roadmap' }
    ]
  }
];

const chineseNav = [
  { text: '从问题开始', link: '/start/choose-a-problem' },
  { text: '建立流程', link: '/start/first-plan' },
  { text: '目标合同', link: '/reference/behavior-contract' },
  { text: '当前可用性', link: '/reference/preview-status' }
];

export default defineConfig({
  root: path.join(currentDir, '..', '..', 'docs', 'zh'),
  base: '/lorebit/',
  siteOrigin: 'https://devcodex-labs.github.io',
  lang: 'zh',
  title: 'lorebit',
  logoText: 'lorebit',
  description: '通用、RAG-first、provider-neutral 的知识工作流用户合同。',
  outDir: path.join(currentDir, 'dist'),
  globalStyles: path.join(currentDir, 'styles', 'lorebit.css'),
  markdown: {
    link: {
      checkDeadLinks: true
    }
  },
  search: {
    codeBlocks: true
  },
  themeConfig: {
    localeRedirect: 'never',
    nav: chineseNav,
    sidebar: {
      '/': chineseSidebar
    },
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/devcodex-labs/lorebit'
      }
    ],
    footer: {
      message: 'Early Preview · 0.x 用户行为合同 · Apache-2.0'
    }
  }
});

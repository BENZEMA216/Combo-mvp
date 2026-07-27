// 默认入口是 API 进程；Worker 由容器入口按 PROCESS=worker 单独启动。
import './processes/api.js';

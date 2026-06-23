// =====================================================================
//  Abstração de fila de jobs: memória ou SQS (1 fila por VPS).
//  O orquestrador faz send(); o agente recebe via /agent/poll (que chama
//  receive()); ao reportar o resultado, o hub chama ack() (deleta no SQS).
//  O RESULTADO sempre volta por HTTP (/agent/result), independente da fila.
// =====================================================================
import { AWS_CONFIG } from '../../config/aws.js';

// ---- MEMÓRIA ------------------------------------------------------------
function makeMemory() {
  const queues = new Map(); // agentId -> [job]
  const q = (id) => { if (!queues.has(id)) queues.set(id, []); return queues.get(id); };
  return {
    knownAgents: () => [...queues.keys()],
    async send(agent, job) { q(agent).push(job); },
    async receive(agent) { return q(agent).shift() || null; },
    async ack() { /* nada: já saiu na receive */ },
  };
}

// ---- SQS ----------------------------------------------------------------
function makeSqs() {
  let client;
  const lazy = async () => {
    if (client) return client;
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    client = new SQSClient({
      region: AWS_CONFIG.region,
      credentials: { accessKeyId: AWS_CONFIG.accessKeyId, secretAccessKey: AWS_CONFIG.secretAccessKey },
    });
    return client;
  };
  const urlFor = (agent) => {
    const u = AWS_CONFIG.sqs?.[agent];
    if (!u) throw new Error(`sem fila SQS configurada para ${agent}`);
    return u;
  };
  const isFifo = (url) => url.endsWith('.fifo');
  return {
    knownAgents: () => Object.keys(AWS_CONFIG.sqs || {}).filter((k) => AWS_CONFIG.sqs[k]),
    async send(agent, job) {
      const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
      const url = urlFor(agent);
      const extra = isFifo(url) ? { MessageGroupId: agent, MessageDeduplicationId: job.id } : {};
      await (await lazy()).send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(job), ...extra }));
    },
    async receive(agent) {
      const { ReceiveMessageCommand } = await import('@aws-sdk/client-sqs');
      const r = await (await lazy()).send(new ReceiveMessageCommand({
        QueueUrl: urlFor(agent), MaxNumberOfMessages: 1, WaitTimeSeconds: 0, VisibilityTimeout: 900,
      }));
      const m = r.Messages?.[0];
      if (!m) return null;
      const job = JSON.parse(m.Body);
      job._receipt = m.ReceiptHandle; // guardado p/ ack
      job._agent = agent;
      return job;
    },
    async ack(job) {
      if (!job?._receipt) return;
      const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
      await (await lazy()).send(new DeleteMessageCommand({ QueueUrl: urlFor(job._agent), ReceiptHandle: job._receipt }));
    },
  };
}

export const queue = AWS_CONFIG.enabled ? makeSqs() : makeMemory();
export const usingSqs = AWS_CONFIG.enabled;

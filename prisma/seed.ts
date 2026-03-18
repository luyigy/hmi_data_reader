import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');

  await prisma.task.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.gateway.deleteMany();

  const gateways = await prisma.gateway.createMany({
    data: [
      {
        name: 'Local Gateway',
        ip: '127.0.0.1',
        status: 'online',
        resources: JSON.stringify({ cpu: 32, memory: 64, disk: 512 }),
      },
      {
        name: 'Remote Gateway A',
        ip: '10.0.8.12',
        status: 'online',
        resources: JSON.stringify({ cpu: 16, memory: 32, disk: 256 }),
      },
      {
        name: 'Remote Gateway B',
        ip: '10.0.8.21',
        status: 'offline',
        resources: JSON.stringify({ cpu: 8, memory: 16, disk: 128 }),
      },
    ],
  });

  const createdGateways = await prisma.gateway.findMany({
    orderBy: { createdAt: 'asc' },
  });

  const [localGateway, remoteGatewayA, remoteGatewayB] = createdGateways;

  await prisma.agent.createMany({
    data: [
      {
        name: 'Agent Alpha',
        type: 'coding',
        location: '本地',
        capabilities: JSON.stringify(['代码生成', '代码审查', '重构']),
        status: 'online',
        lastHeartbeat: new Date(),
        gatewayId: localGateway?.id,
      },
      {
        name: 'Agent Beta',
        type: 'analysis',
        location: '云端',
        capabilities: JSON.stringify(['数据分析', '监控', '报告生成']),
        status: 'online',
        lastHeartbeat: new Date(Date.now() - 1000 * 60 * 5),
        gatewayId: remoteGatewayA?.id,
      },
      {
        name: 'Agent Gamma',
        type: 'communication',
        location: '本地',
        capabilities: JSON.stringify(['消息处理', '通知发送', '群聊管理']),
        status: 'busy',
        lastHeartbeat: new Date(Date.now() - 1000 * 60 * 2),
        gatewayId: localGateway?.id,
      },
      {
        name: 'Agent Delta',
        type: 'coding',
        location: '远程',
        capabilities: JSON.stringify(['测试', '部署', 'CI/CD']),
        status: 'busy',
        lastHeartbeat: new Date(Date.now() - 1000 * 60 * 12),
        gatewayId: remoteGatewayA?.id,
      },
      {
        name: 'Agent Epsilon',
        type: 'monitoring',
        location: '远程',
        capabilities: JSON.stringify(['日志采集', '告警', '指标分析']),
        status: 'offline',
        lastHeartbeat: new Date(Date.now() - 1000 * 60 * 60 * 6),
        gatewayId: remoteGatewayB?.id,
      },
      {
        name: 'Agent Zeta',
        type: 'operations',
        location: '云端',
        capabilities: JSON.stringify(['自动化运维', '备份', '恢复']),
        status: 'offline',
        lastHeartbeat: new Date(Date.now() - 1000 * 60 * 60 * 24),
        gatewayId: remoteGatewayB?.id,
      },
    ],
  });

  console.log('Gateways created:', gateways.count);
  console.log('Agents created:', 6);
  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { executeTask, executeTaskBatch } from '@/lib/agent-executor';

/**
 * POST /api/tasks/[id]/execute
 * 
 * 执行任务 - 将任务发送给分配的 Agent
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    
    // 获取任务信息
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignedAgents: true,
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    // 检查任务状态
    if (task.status !== 'pending' && task.status !== 'running') {
      return NextResponse.json(
        { error: 'Task is not in pending or running status' },
        { status: 400 }
      );
    }

    // 如果没有分配 Agent，返回错误
    if (task.assignedAgents.length === 0) {
      return NextResponse.json(
        { error: 'No agents assigned to this task' },
        { status: 400 }
      );
    }

    // 更新任务状态为 running
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'running',
        startedAt: task.startedAt || new Date(),
      },
    });

    // 准备任务数据
    const taskData = {
      id: task.id,
      name: task.name,
      description: task.description || undefined,
      assignedAgents: task.assignedAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        location: agent.location || undefined,
      })),
    };

    // 执行任务给所有分配的 Agent
    const agentIds = task.assignedAgents.map((a) => a.id);
    const results = await executeTaskBatch(taskData, agentIds);

    // 汇总结果
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    // 更新任务结果
    const resultData = {
      executedAt: new Date().toISOString(),
      totalAgents: results.length,
      successCount,
      failCount,
      results: results.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        success: r.success,
        result: r.result,
        error: r.error,
        duration: r.duration,
      })),
    };

    // 如果所有 Agent 都成功，标记任务为 completed
    const finalStatus = failCount === 0 ? 'completed' : 'failed';
    
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: finalStatus,
        completedAt: new Date(),
        result: JSON.stringify(resultData),
        error: failCount > 0 ? `${failCount} agent(s) failed` : undefined,
      },
    });

    return NextResponse.json({
      taskId,
      status: finalStatus,
      ...resultData,
    });
  } catch (error) {
    console.error('Failed to execute task:', error);
    return NextResponse.json(
      { error: 'Failed to execute task' },
      { status: 500 }
    );
  }
}

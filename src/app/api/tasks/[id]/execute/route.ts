import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { executeTaskBatch } from '@/lib/agent-executor';
import { getSocketServer } from '@/lib/websocket';
import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import type { AcpxParticipantRequest, AcpxOrchestrationMode } from '@/lib/acpx/types';
import { ensureTaskChatRoom } from '@/lib/task-room';

/**
 * POST /api/tasks/[id]/execute
 * 
 * 执行任务 - 将任务发送给分配的 Agent
 * 自动创建聊天室并发送 Agent 消息
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

    const isAcpxTask = task.executionMode === 'acpx';
    const acpxParticipants = isAcpxTask
      ? (() => {
          try {
            return JSON.parse(task.acpxParticipants || '[]') as AcpxParticipantRequest[];
          } catch {
            return [];
          }
        })()
      : [];

    // 如果没有分配 Agent，返回错误
    if (!isAcpxTask && task.assignedAgents.length === 0) {
      return NextResponse.json(
        { error: 'No agents assigned to this task' },
        { status: 400 }
      );
    }

    if (isAcpxTask && acpxParticipants.length === 0) {
      return NextResponse.json(
        { error: 'ACPX task requires participants' },
        { status: 400 }
      );
    }

    // 自动创建聊天室（如果不存在）
    const chatRoom = await ensureTaskChatRoom(task.id, task.name);
    console.log('[Task Execute] Using chat room:', chatRoom.id);

    // 发送系统消息到聊天室
    const sendChatMessage = async (content: string, userName: string = '系统') => {
      try {
        await prisma.message.create({
          data: {
            content,
            roomId: chatRoom!.id,
            userId: 'system',
            userName,
          },
        });
        
        // 通过 WebSocket 广播
        const io = getSocketServer();
        if (io) {
          io.to(chatRoom!.id).emit('chat:message', {
            id: `task-${Date.now()}`,
            roomId: chatRoom!.id,
            user: { id: 'system', name: userName },
            content,
            createdAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error('Failed to send chat message:', error);
      }
    };

    // 发送任务开始消息
    await sendChatMessage(
      isAcpxTask
        ? `🚀 ACPX 任务 "${task.name}" 开始执行`
        : `🚀 任务 "${task.name}" 开始执行，分配给 ${task.assignedAgents.length} 个 Agent`
    );

    // 更新任务状态为 running
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'running',
        startedAt: task.startedAt || new Date(),
      },
    });

    if (isAcpxTask) {
      const runResult = await executeAcpxTaskRun({
        taskId: task.id,
        taskName: task.name,
        taskDescription: task.description || undefined,
        orchestrationMode:
          acpxParticipants.length > 1 ? ('staged' as AcpxOrchestrationMode) : ('single' as AcpxOrchestrationMode),
        participants: acpxParticipants,
        workingDirectory: task.workingDirectory || undefined,
      });

      const finalStatus = runResult.status === 'completed' ? 'completed' : 'failed';
      const resultData = {
        executionMode: 'acpx',
        taskRunId: runResult.taskRunId,
        orchestrationMode: acpxParticipants.length > 1 ? 'staged' : 'single',
        summary: runResult.summary,
        participants: runResult.participants,
        completedAt: new Date().toISOString(),
      };

      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          result: JSON.stringify(resultData),
          error: finalStatus === 'failed' ? 'ACPX run failed' : undefined,
        },
      });

      await sendChatMessage(
        finalStatus === 'completed'
          ? `✅ ACPX 任务执行完成`
          : `❌ ACPX 任务执行失败`
      );

      return NextResponse.json({
        taskId,
        status: finalStatus,
        chatRoomId: chatRoom.id,
        ...resultData,
      });
    }

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

    // 发送每个 Agent 的执行消息（包含完整输出）
    for (const result of results) {
      if (result.success) {
        // 提取 Agent 的真实输出内容
        const agentOutput = result.result?.output || result.result?.message || '任务执行完成';
        
        // 发送 Agent 输出到聊天室
        await sendChatMessage(agentOutput, result.agentName);
        
        // 如果是结构化结果，也发送详细信息
        if (result.result && typeof result.result === 'object') {
          const details = JSON.stringify(result.result, null, 2);
          if (details.length > 0 && details !== '{}') {
            await sendChatMessage(
              `📊 执行详情:\n\`\`\`json\n${details.substring(0, 1000)}${details.length > 1000 ? '...' : ''}\n\`\`\``,
              result.agentName
            );
          }
        }
      } else {
        await sendChatMessage(
          `❌ 执行失败：${result.error || '未知错误'}`,
          result.agentName
        );
      }
    }

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

    // 发送任务完成消息
    await sendChatMessage(
      finalStatus === 'completed'
        ? `✅ 任务执行完成！成功：${successCount}, 失败：${failCount}`
        : `❌ 任务执行失败！成功：${successCount}, 失败：${failCount}`
    );

    return NextResponse.json({
      taskId,
      status: finalStatus,
      chatRoomId: chatRoom.id,
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

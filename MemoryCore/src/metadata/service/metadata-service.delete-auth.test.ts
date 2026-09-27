/**
 * deleteAgentsForCaller / archiveAgentForCaller 权限放宽（#1321）的 service 层测试。
 *
 * 覆盖矩阵：owner / team admin / system_admin / 无关用户 × 删除与归档，
 * 以及 removeTeamMemberForCaller / deleteUsersForCaller 的级联行为与跨 team 隔离。
 * store 侧的级联细节（task_agents / fixed_assets / chat_memory）由
 * metadata-store.contract.ts 的契约用例覆盖，这里断言到 service 语义为止。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MetadataService } from "./metadata-service.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { V3AuthContext } from "../router/auth.js";
import type { AgentEntity, UserEntity } from "../types.js";

let store: SqliteMetadataStore;
let svc: MetadataService;
let seq = 0;

beforeEach(() => {
  store = new SqliteMetadataStore(":memory:");
  store.init();
  svc = new MetadataService(store);
});

async function makeUser(): Promise<UserEntity> {
  seq += 1;
  return store.createUser({
    auth_provider: "local",
    external_id: `ext-${seq}`,
    username: `user${seq}`,
  });
}

function ctxFor(user: UserEntity, over: Partial<V3AuthContext> = {}): V3AuthContext {
  return {
    token: `test-key-${user.user_id}`,
    userId: user.user_id,
    isAdmin: false,
    isSystemAdmin: false,
    ...over,
  };
}

async function seedTeamWithAgent(owner: UserEntity, member?: UserEntity) {
  const team = await store.createTeam({ name: `team-${++seq}`, owner_user_id: owner.user_id });
  if (member) {
    await store.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
  }
  const agent: AgentEntity = await store.createAgent({
    team_id: team.team_id,
    owner_user_id: (member ?? owner).user_id,
    name: `agent-${++seq}`,
  });
  return { team, agent };
}

describe("deleteAgentsForCaller 权限矩阵", () => {
  it("owner 可以删除自己的 agent", async () => {
    const owner = await makeUser();
    const { agent } = await seedTeamWithAgent(owner);

    const result = await svc.deleteAgentsForCaller([agent.agent_id], ctxFor(owner));
    expect(result.deleted_ids).toContain(agent.agent_id);
    expect(await store.getAgentById(agent.agent_id)).toBeNull();
  });

  it("team admin 可以代删成员的 agent", async () => {
    const admin = await makeUser();
    const member = await makeUser();
    const { agent } = await seedTeamWithAgent(admin, member);

    const result = await svc.deleteAgentsForCaller([agent.agent_id], ctxFor(admin));
    expect(result.deleted_ids).toContain(agent.agent_id);
  });

  it("system_admin 无需 team 成员身份即可删除", async () => {
    const owner = await makeUser();
    const sysadmin = await makeUser();
    const { agent } = await seedTeamWithAgent(owner);

    const result = await svc.deleteAgentsForCaller([agent.agent_id], ctxFor(sysadmin, { isSystemAdmin: true }));
    expect(result.deleted_ids).toContain(agent.agent_id);
  });

  it("无关用户删除他人 agent 被拒绝", async () => {
    const owner = await makeUser();
    const bystander = await makeUser();
    const { agent } = await seedTeamWithAgent(owner);

    await expect(
      svc.deleteAgentsForCaller([agent.agent_id], ctxFor(bystander)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await store.getAgentById(agent.agent_id)).not.toBeNull();
  });

  it("system_admin 删除不存在的 agent 显式 404，而非静默成功", async () => {
    const sysadmin = await makeUser();

    await expect(
      svc.deleteAgentsForCaller(["agt-not-exist"], ctxFor(sysadmin, { isSystemAdmin: true })),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("system_admin 归档不存在的 agent 同样显式 404", async () => {
    const sysadmin = await makeUser();

    await expect(
      svc.archiveAgentForCaller("agt-not-exist", ctxFor(sysadmin, { isSystemAdmin: true })),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });
});

describe("archiveAgentForCaller 权限矩阵", () => {
  it("team admin 可以代归档成员的 agent", async () => {
    const admin = await makeUser();
    const member = await makeUser();
    const { agent } = await seedTeamWithAgent(admin, member);

    const archived = await svc.archiveAgentForCaller(agent.agent_id, ctxFor(admin));
    expect(archived.status).toBe("inactive");
  });

  it("system_admin 无需成员身份即可归档", async () => {
    const owner = await makeUser();
    const sysadmin = await makeUser();
    const { agent } = await seedTeamWithAgent(owner);

    const archived = await svc.archiveAgentForCaller(
      agent.agent_id,
      ctxFor(sysadmin, { isSystemAdmin: true }),
    );
    expect(archived.status).toBe("inactive");
  });

  it("普通成员（非 admin）归档他人 agent 被拒绝", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    // agent 归 owner 所有；member 只是普通成员 —— 归档对象不是自己的资产
    const { agent } = await seedTeamWithAgent(owner);
    await store.addTeamMember({ team_id: agent.team_id, user_id: member.user_id, role: "member" });

    await expect(
      svc.archiveAgentForCaller(agent.agent_id, ctxFor(member)),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("removeTeamMemberForCaller 级联", () => {
  it("移除成员时级联删除其在本 team 的 agent，其他 team 的 agent 不受影响", async () => {
    const teamOwner = await makeUser();
    const member = await makeUser();
    const { team, agent: agentInTeam } = await seedTeamWithAgent(teamOwner, member);

    // 成员在另一个 team（自己是 owner）名下还有 agent
    const otherTeam = await store.createTeam({ name: `team-${++seq}`, owner_user_id: member.user_id });
    const agentElsewhere = await store.createAgent({
      team_id: otherTeam.team_id,
      owner_user_id: member.user_id,
      name: `agent-${++seq}`,
    });

    // team owner 自动具备 admin 角色
    await svc.removeTeamMemberForCaller(team.team_id, member.user_id, ctxFor(teamOwner));

    expect(await store.getAgentById(agentInTeam.agent_id)).toBeNull();
    expect(await store.getAgentById(agentElsewhere.agent_id)).not.toBeNull();
    expect(await store.getTeamMember(team.team_id, member.user_id)).toBeNull();
  });

  it("team admin 不能移除 team owner（owner 保护的分支）", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const anotherAdmin = await makeUser();
    const { team, agent } = await seedTeamWithAgent(owner, member);
    await store.addTeamMember({ team_id: team.team_id, user_id: anotherAdmin.user_id, role: "admin" });

    // anotherAdmin 通过 team admin 校验后，命中 cannot remove team owner 保护
    await expect(
      svc.removeTeamMemberForCaller(team.team_id, owner.user_id, ctxFor(anotherAdmin)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await store.getAgentById(agent.agent_id)).not.toBeNull();
  });
});

describe("deleteUsersForCaller 级联", () => {
  it("删除用户前级联删除其所有 team 的 agent，随后用户被删", async () => {
    const sysadmin = await makeUser();
    const victim = await makeUser();
    const teamA = await store.createTeam({ name: `team-${++seq}`, owner_user_id: sysadmin.user_id });
    const teamB = await store.createTeam({ name: `team-${++seq}`, owner_user_id: victim.user_id });
    await store.addTeamMember({ team_id: teamA.team_id, user_id: victim.user_id, role: "member" });
    const agentA = await store.createAgent({
      team_id: teamA.team_id,
      owner_user_id: victim.user_id,
      name: `agent-${++seq}`,
    });
    const agentB = await store.createAgent({
      team_id: teamB.team_id,
      owner_user_id: victim.user_id,
      name: `agent-${++seq}`,
    });

    await svc.deleteUsersForCaller([victim.user_id], ctxFor(sysadmin, { isSystemAdmin: true }));

    expect(await store.getAgentById(agentA.agent_id)).toBeNull();
    expect(await store.getAgentById(agentB.agent_id)).toBeNull();
    expect(await store.getUserById(victim.user_id)).toBeNull();
  });

  it("非 system_admin 不能删除用户", async () => {
    const teamOwner = await makeUser();
    const victim = await makeUser();

    await expect(
      svc.deleteUsersForCaller([victim.user_id], ctxFor(teamOwner)),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

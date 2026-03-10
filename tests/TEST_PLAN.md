# Agent Platform v2 Test Plan

## 1. Functional Test Cases

### 1.1 Dashboard
- **Agent Status Display:** Verify that the dashboard accurately displays the status of all agents (online, busy, offline).
- **Node Status Display:** Verify that the dashboard accurately displays the status of all nodes (local, remoteA, remoteB).
- **Task List Display:** Verify that the dashboard correctly lists active and completed tasks.
- **Real-time Updates:** Verify that agent, node, and task statuses update in real-time without manual refresh.
- **Filtering/Sorting:** (If applicable) Verify that filtering and sorting options for agents, nodes, and tasks work as expected.

### 1.2 API
- **Agent Management API:**
    - `GET /agents`: Verify retrieval of all agent information.
    - `GET /agents/{id}`: Verify retrieval of a single agent's information.
    - `POST /agents`: Verify creation of new agents.
    - `PUT /agents/{id}`: Verify updating agent status (online, busy, offline).
    - `DELETE /agents/{id}`: Verify deletion of agents.
- **Node Management API:**
    - `GET /nodes`: Verify retrieval of all node information.
    - `GET /nodes/{id}`: Verify retrieval of a single node's information.
    - `POST /nodes`: Verify creation of new nodes.
    - `PUT /nodes/{id}`: Verify updating node status.
    - `DELETE /nodes/{id}`: Verify deletion of nodes.
- **Task Management API:**
    - `GET /tasks`: Verify retrieval of all task information.
    - `GET /tasks/{id}`: Verify retrieval of a single task's information.
    - `POST /tasks`: Verify creation and assignment of new tasks.
    - `PUT /tasks/{id}`: Verify updating task status (pending, in-progress, completed, failed).
    - `DELETE /tasks/{id}`: Verify deletion of tasks.
- **Error Handling:** Verify appropriate error responses for invalid requests (e.g., missing parameters, invalid IDs, unauthorized access).

### 1.3 Components
- **Agent Card Component:** Verify correct display of agent name, status, and associated node.
- **Node Card Component:** Verify correct display of node name, type, and associated agents/tasks.
- **Task Item Component:** Verify correct display of task description, status, and assigned agent/node.
- **Input Fields/Forms:** Verify proper input validation and submission for creating/updating entities.
- **Navigation:** Verify that all navigation elements (if any) lead to the correct views/pages.

## 2. Acceptance Criteria

- All specified API endpoints return correct data structures and HTTP status codes.
- The Dashboard accurately reflects the state of agents, nodes, and tasks with minimal latency.
- CRUD operations for Agents, Nodes, and Tasks function correctly through both UI (if applicable) and API.
- Error messages are clear, informative, and consistent across the platform.
- The application is responsive and performs well under typical load conditions.
- No critical data loss or corruption occurs during any operation.

## 3. Test Steps

1. **Setup Test Environment:**
    - Clone the `agent-platform-v2` repository.
    - Install dependencies (`npm install` or `yarn install`).
    - Configure environment variables (if any).
    - Run database migrations (`npx prisma migrate dev`).
    - Seed initial test data using `prisma/seed.ts`.
    - Start the application (`npm run dev` or equivalent).

2. **Execute Dashboard Tests:**
    - Navigate to the dashboard in a web browser.
    - Observe agent, node, and task displays.
    - Manually change agent/task/node statuses via API (or UI if available) and observe real-time updates on the dashboard.
    - Interact with any available filtering/sorting options.

3. **Execute API Tests:**
    - Use `tests/api-test.http` or a tool like Postman/Insomnia to send requests to each endpoint.
    - Verify request and response payloads against expected schemas.
    - Test edge cases, invalid inputs, and error conditions.

4. **Execute Component Tests:**
    - Visually inspect individual components on the dashboard or specific pages.
    - Interact with forms and input fields to ensure correct behavior and validation.

5. **Code Quality Review (Manual):**
    - Review `prisma/seed.ts` for correct data generation logic.
    - Review `tests/build-test.sh` for build process validation.
    - Review `tests/api-test.http` for comprehensive API test coverage.
    - Examine relevant TypeScript files for type completeness, component prop definitions, and API error handling.

6. **Reporting:**
    - Document any bugs, issues, or discrepancies found.
    - Provide suggestions for improvements in code quality or functionality.
    - Confirm all completion criteria are met.

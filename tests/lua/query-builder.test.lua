local calls = {}
local response = { { id = 1, name = 'Avery' } }
local failure
local callbackErrors = false

promise = { new = function()
	return {
		resolve = function(self, value) self.done = true; self.value = value end,
		reject = function(self, message) self.done = true; self.failure = message end,
	}
end }
Citizen = {
	Await = function(pending)
		assert(pending.done, 'promise was not settled')
		if pending.failure then error(pending.failure) end
		return pending.value
	end,
	CreateThreadNow = function(callback) callback() end,
}
GetCurrentResourceName = function() return 'facade-test' end
GetResourceState = function() return 'started' end
GetNumResourceMetadata = function() return callbackErrors and 1 or 0 end
GetResourceMetadata = function() return 'return_callback_errors' end
exports = { oxmysql = setmetatable({}, { __index = function(_, method)
	return function(_, query, parameters, callback, resource, isPromise)
		calls[#calls + 1] = { method = method, query = query, parameters = parameters, callback = callback, resource = resource, isPromise = isPromise }
		if callback then callback(failure and nil or response, failure) end
	end
end }) }

dofile('lib/MySQL.lua')
local op = MySQL.op
local count = 0

local function same(actual, expected)
	assert(type(actual) == type(expected), 'types differ: ' .. type(actual) .. ' / ' .. type(expected))
	if type(expected) ~= 'table' then assert(actual == expected, 'values differ'); return end
	assert(getmetatable(actual) == nil, 'export spec must not have metatables')
	for key, value in pairs(expected) do same(actual[key], value) end
	for key in pairs(actual) do assert(expected[key] ~= nil, 'unexpected key: ' .. tostring(key)) end
end

local function rejects(callback)
	local ok, message = pcall(callback)
	assert(not ok and tostring(message):find('queryBuilder:'), 'expected queryBuilder validation failure')
end

local function test(name, callback)
	callback()
	count = count + 1
	print('PASS ' .. name)
end

local function id(...)
	return { kind = 'identifier', parts = { ... } }
end

test('POC example exports exact plain-data specification and awaits', function()
	local result = MySQL.table('users'):select({ 'id', 'name' }):where(op.eq('active', true))
		:where(op.inArray('role', { 'admin', 'moderator' })):limit(10):get()
	assert(result == response)
	local call = calls[#calls]
	assert(call.method == 'queryBuilder' and call.parameters == 'query' and call.resource == 'facade-test' and call.isPromise == true)
	same(call.query, {
		kind = 'select', from = id('users'), columns = { id('id'), id('name') }, limit = 10,
		where = { kind = 'group', operator = 'allOf', predicates = {
			{ kind = 'comparison', operator = 'eq', column = id('active'), value = true },
			{ kind = 'collection', operator = 'inArray', column = id('role'), values = { 'admin', 'moderator' } },
		} },
	})
end)

test('operators preserve scalar values, qualified names and empty collections', function()
	same(op.eq('users.na`me', false), { kind = 'comparison', operator = 'eq', column = id('users', 'na`me'), value = false })
	same(op.inArray('id', {}), { kind = 'collection', operator = 'inArray', column = id('id'), values = {} })
	same(op.allOf(op.eq('id', 0)), { kind = 'group', operator = 'allOf', predicates = { op.eq('id', 0) } })
	MySQL.table('app.users'):get()
	same(calls[#calls].query, { kind = 'select', from = id('app', 'users'), columns = '*' })
end)

test('base builders and first limits are immutable', function()
	local base = MySQL.table('users'):where(op.eq('active', true)):limit(10)
	base:where(op.eq('id', 1)):first()
	assert(calls[#calls].parameters == 'single' and calls[#calls].query.limit == 1)
	base:get()
	assert(calls[#calls].query.limit == 10 and calls[#calls].query.where.kind == 'comparison')
	base:limit(0):first()
	assert(calls[#calls].query.limit == 0)
	MySQL.table('users'):first()
	assert(calls[#calls].query.limit == 1)
	rejects(function() base.limit = 20 end)
end)

test('caller-owned tables and exported snapshots cannot mutate a builder', function()
	local columns = { 'id' }
	local values = { 1, 2 }
	local predicate = op.inArray('id', values)
	local group = op.allOf(predicate)
	local base = MySQL.table('users'):select(columns):where(group)
	columns[1] = 'other'; values[1] = 99; predicate.values[1] = 98; group.predicates[1].values[1] = 97
	base:get()
	same(calls[#calls].query.columns, { id('id') })
	same(calls[#calls].query.where.predicates[1].values, { 1, 2 })
	calls[#calls].query.from.parts[1] = 'other'
	calls[#calls].query.where.predicates[1].values[1] = 96
	base:get()
	same(calls[#calls].query.from, id('users'))
	same(calls[#calls].query.where.predicates[1].values, { 1, 2 })
end)

test('repeated where normalizes one allOf and retains nested ordering', function()
	MySQL.table('users'):where(op.eq('id', 1)):where(op.eq('id', 2)):where(op.allOf(op.eq('id', 3), op.eq('id', 4))):get()
	same(calls[#calls].query.where, op.allOf(op.eq('id', 1), op.eq('id', 2), op.allOf(op.eq('id', 3), op.eq('id', 4))))
end)

test('callback terminals and promise rejections match the existing Lua path', function()
	local received
	MySQL.table('users'):get(function(result) received = result end)
	assert(received == response and calls[#calls].isPromise == false)
	MySQL.table('users'):first(function(result) received = result end)
	assert(received == response and calls[#calls].parameters == 'single')
	failure = 'queryBuilder: expected failure'
	rejects(function() MySQL.table('users'):get() end)
	failure = nil
	callbackErrors = true
	dofile('lib/MySQL.lua')
	MySQL.table('users'):get(function() end)
	assert(calls[#calls].isPromise == true)
end)

test('obvious misuse fails locally without calling an export', function()
	local before = #calls
	for _, name in ipairs({ '', '.', '.users', 'users.', 'users..id', ' ', 'us?ers', '*', 'us\0ers' }) do
		rejects(function() MySQL.table(name) end)
	end
	rejects(function() op.eq('id', nil) end)
	rejects(function() op.eq('id', {}) end)
	rejects(function() op.eq('id', function() end) end)
	rejects(function() op.eq('id', math.huge) end)
	rejects(function() op.inArray('id', { [1] = 1, [3] = 3 }) end)
	rejects(function() op.inArray('id', { named = 1 }) end)
	rejects(function() op.allOf() end)
	rejects(function() op.allOf(op.eq('id', 1), nil) end)
	rejects(function() MySQL.table('users'):select({}) end)
	rejects(function() MySQL.table('users'):select('*') end)
	rejects(function() MySQL.table('users'):where('id = 1') end)
	rejects(function() MySQL.table('users'):where({ kind = 'raw', sql = '1=1' }) end)
	rejects(function() MySQL.table('users'):where({ kind = 'comparison', operator = '=', column = id('id'), value = 1 }) end)
	for _, limit in ipairs({ -1, 1.5, math.huge, 9007199254740992, '1', false }) do
		rejects(function() MySQL.table('users'):limit(limit) end)
	end
	rejects(function() MySQL.table('users'):get(false) end)
	rejects(function() MySQL.table('users'):update({ id = 2 }) end)
	assert(#calls == before, 'invalid API use must not call an export')
end)

test('raw APIs, stored references and aliases still bypass the builder', function()
	assert(MySQL.query.await('SELECT ?', { 1 }) == response)
	assert(calls[#calls].method == 'query' and calls[#calls].query == 'SELECT ?')
	local reference = MySQL.Async.store('SELECT @id')
	MySQL.Async.fetchAll(reference, { id = 1 }, function() end)
	assert(calls[#calls].method == 'query' and calls[#calls].query == 'SELECT @id')
	MySQL.Sync.fetchAll(reference, { id = 1 })
	assert(calls[#calls].method == 'query' and calls[#calls].isPromise == true)
	for _, method in ipairs({ 'scalar', 'single', 'insert', 'update', 'prepare', 'rawExecute', 'transaction' }) do
		MySQL[method].await(method == 'transaction' and { 'SELECT 1' } or 'SELECT 1', {})
		assert(calls[#calls].method == method)
	end
end)

print(('Lua query-builder contract: %d tests passed'):format(count))
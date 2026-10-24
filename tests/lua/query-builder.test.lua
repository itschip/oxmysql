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
assert(Builder == nil, 'MySQL import must work without creating Builder')
assert(MySQL.query.await('SELECT 1') == response)
MySQL = nil
dofile('lib/Builder.lua')
assert(MySQL == nil, 'Builder import must work without creating MySQL')
assert(Builder.table('users'):get() == response)
local importedBuilder = Builder
dofile('lib/MySQL.lua')
assert(Builder == importedBuilder, 'MySQL import must preserve Builder')
assert(rawget(MySQL, 'table') == nil and rawget(MySQL, 'op') == nil, 'builder API must be separate from MySQL')
local op = Builder.op
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

test('Builder import after MySQL preserves raw APIs and existing builders', function()
	local rawMySQL = MySQL
	local rawQuery = MySQL.query
	local base = Builder.table('users')
	dofile('lib/Builder.lua')
	assert(MySQL == rawMySQL and MySQL.query == rawQuery, 'Builder import must preserve raw APIs')
	base:get()
	assert(calls[#calls].method == 'queryBuilder')
	Builder.table('users'):get()
	assert(calls[#calls].method == 'queryBuilder')
end)

test('POC example exports exact plain-data specification and awaits', function()
	local result = Builder.table('users'):select({ 'id', 'name' }):where(op.eq('active', true))
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
	Builder.table('app.users'):get()
	same(calls[#calls].query, { kind = 'select', from = id('app', 'users'), columns = '*' })
end)

test('base builders and first limits are immutable', function()
	local base = Builder.table('users'):where(op.eq('active', true)):limit(10)
	base:where(op.eq('id', 1)):first()
	assert(calls[#calls].parameters == 'single' and calls[#calls].query.limit == 1)
	base:get()
	assert(calls[#calls].query.limit == 10 and calls[#calls].query.where.kind == 'comparison')
	base:limit(0):first()
	assert(calls[#calls].query.limit == 0)
	Builder.table('users'):first()
	assert(calls[#calls].query.limit == 1)
	rejects(function() base.limit = 20 end)
end)

test('caller-owned tables and exported snapshots cannot mutate a builder', function()
	local columns = { 'id' }
	local values = { 1, 2 }
	local predicate = op.inArray('id', values)
	local group = op.allOf(predicate)
	local base = Builder.table('users'):select(columns):where(group)
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
	Builder.table('users'):where(op.eq('id', 1)):where(op.eq('id', 2)):where(op.allOf(op.eq('id', 3), op.eq('id', 4))):get()
	same(calls[#calls].query.where, op.allOf(op.eq('id', 1), op.eq('id', 2), op.allOf(op.eq('id', 3), op.eq('id', 4))))
end)

test('callback terminals and promise rejections match the existing Lua path', function()
	local received
	Builder.table('users'):get(function(result) received = result end)
	assert(received == response and calls[#calls].isPromise == false)
	Builder.table('users'):first(function(result) received = result end)
	assert(received == response and calls[#calls].parameters == 'single')
	failure = 'queryBuilder: expected failure'
	rejects(function() Builder.table('users'):get() end)
	failure = nil
	callbackErrors = true
	dofile('lib/Builder.lua')
	Builder.table('users'):get(function() end)
	assert(calls[#calls].isPromise == true)
end)

test('obvious misuse fails locally without calling an export', function()
	local before = #calls
	for _, name in ipairs({ '', '.', '.users', 'users.', 'users..id', ' ', 'us?ers', '*', 'us\0ers' }) do
		rejects(function() Builder.table(name) end)
	end
	rejects(function() op.eq('id', nil) end)
	rejects(function() op.eq('id', {}) end)
	rejects(function() op.eq('id', function() end) end)
	rejects(function() op.eq('id', math.huge) end)
	rejects(function() op.inArray('id', { [1] = 1, [3] = 3 }) end)
	rejects(function() op.inArray('id', { named = 1 }) end)
	rejects(function() op.allOf() end)
	rejects(function() op.allOf(op.eq('id', 1), nil) end)
	rejects(function() Builder.table('users'):select({}) end)
	rejects(function() Builder.table('users'):select('*') end)
	rejects(function() Builder.table('users'):where('id = 1') end)
	rejects(function() Builder.table('users'):where({ kind = 'raw', sql = '1=1' }) end)
	rejects(function() Builder.table('users'):where({ kind = 'comparison', operator = '=', column = id('id'), value = 1 }) end)
	for _, limit in ipairs({ -1, 1.5, math.huge, 9007199254740992, '1', false }) do
		rejects(function() Builder.table('users'):limit(limit) end)
	end
	rejects(function() Builder.table('users'):get(false) end)
	rejects(function() Builder.table('users'):update({ id = 2 }) end)
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

test('insert and update export exact specs in await and callback forms', function()
	local base = Builder.table('app.users')
	local previousResponse = response
	response = 42
	assert(base:insert({ name = 'Avery', active = true }) == 42)
	local call = calls[#calls]
	assert(call.parameters == 'insert' and call.resource == 'facade-test' and call.isPromise == true)
	same(call.query, { kind = 'insert', into = id('app', 'users'), rows = { { name = 'Avery', active = true } } })
	local received
	base:insert({ { name = 'Blake', active = false }, { active = true, name = 'Casey' } }, function(result) received = result end)
	assert(received == 42 and calls[#calls].parameters == 'insert')
	same(calls[#calls].query.rows, { { name = 'Blake', active = false }, { name = 'Casey', active = true } })
	response = 0
	local filtered = base:where(op.eq('id', 7))
	assert(filtered:update({ active = false }) == 0)
	assert(calls[#calls].parameters == 'update')
	same(calls[#calls].query, { kind = 'update', table = id('app', 'users'), values = { active = false }, where = op.eq('id', 7) })
	filtered:update({ name = '' }, function(result) received = result end)
	assert(received == 0 and calls[#calls].parameters == 'update')
	failure = 'queryBuilder: mutation failed'
	rejects(function() base:insert({ name = 'Avery' }) end)
	rejects(function() filtered:update({ active = false }) end)
	failure = nil
	response = previousResponse
end)

test('allowAll is explicit, immutable and still preserves a supplied predicate', function()
	local base = Builder.table('users')
	local all = base:allowAll()
	all:update({ active = false })
	same(calls[#calls].query, { kind = 'update', table = id('users'), values = { active = false }, allowAll = true })
	all:where(op.eq('id', 1)):update({ name = 'Avery' })
	same(calls[#calls].query.where, op.eq('id', 1))
	assert(calls[#calls].query.allowAll == true)
	rejects(function() base:update({ active = true }) end)
	base:get()
	assert(calls[#calls].query.kind == 'select' and calls[#calls].query.allowAll == nil)
end)

test('mutation snapshots cannot change the base or caller-owned values', function()
	local base = Builder.table('users'):where(op.eq('id', 1))
	local values = { active = false, name = 'Avery' }
	base:update(values)
	calls[#calls].query.values.name = 'changed'
	calls[#calls].query.table.parts[1] = 'other'
	calls[#calls].query.where.value = 99
	assert(values.name == 'Avery')
	base:update(values)
	same(calls[#calls].query.values, values)
	same(calls[#calls].query.table, id('users'))
	same(calls[#calls].query.where, op.eq('id', 1))
	local rows = { { id = 1, active = false }, { active = true, id = 2 } }
	local plain = Builder.table('users')
	plain:insert(rows)
	calls[#calls].query.rows[1].id = 99
	assert(rows[1].id == 1)
	plain:insert(rows)
	same(calls[#calls].query.rows, rows)
	base:get()
	assert(calls[#calls].query.kind == 'select' and calls[#calls].query.values == nil)
end)

test('malformed mutations and unsupported chains fail before exporting', function()
	local before = #calls
	local base = Builder.table('users')
	local filtered = base:where(op.eq('id', 1))
	for _, values in ipairs({ {}, { [1] = 'value' }, { ['users.id'] = 1 }, { ['na?me'] = 1 }, { name = {} }, { name = math.huge }, setmetatable({ name = 'Avery' }, {}) }) do
		rejects(function() base:insert(values) end)
		rejects(function() filtered:update(values) end)
	end
	rejects(function() base:insert(nil) end)
	rejects(function() filtered:update(nil) end)
	rejects(function() base:insert({ {} }) end)
	rejects(function() base:insert({ { id = 1 }, { name = 'Avery' } }) end)
	rejects(function() base:insert({ { id = 1 }, { id = 2, name = 'Avery' } }) end)
	rejects(function() base:insert({ [1] = { id = 1 }, [3] = { id = 3 } }) end)
	rejects(function() base:insert({ [1] = { id = 1 }, name = 'Avery' }) end)
	rejects(function() filtered:insert({ id = 1 }) end)
	rejects(function() base:allowAll():insert({ id = 1 }) end)
	rejects(function() base:allowAll():get() end)
	rejects(function() base:allowAll():first() end)
	rejects(function() base:select({ 'id' }):insert({ id = 1 }) end)
	rejects(function() filtered:select({ 'id' }):update({ id = 2 }) end)
	rejects(function() base:limit(1):insert({ id = 1 }) end)
	rejects(function() filtered:limit(1):update({ id = 2 }) end)
	rejects(function() base:insert({ id = 1 }, false) end)
	rejects(function() filtered:update({ id = 2 }, false) end)
	assert(#calls == before, 'invalid mutation must not call an export')
end)

print(('Lua query-builder contract: %d tests passed'):format(count))

local promise = promise
local Await = Citizen.Await
local resourceName = GetCurrentResourceName()
local GetResourceState = GetResourceState

local options = {
	return_callback_errors = false
}

for i = 1, GetNumResourceMetadata(resourceName, 'mysql_option') do
	local option = GetResourceMetadata(resourceName, 'mysql_option', i - 1)
	options[option] = true
end

local function await(fn, query, parameters)
	local p = promise.new()

	fn(nil, query, parameters, function(result, error)
		if error then
			return p:reject(error)
		end

		p:resolve(result)
	end, resourceName, true)

	return Await(p)
end

local type = type
local queryStore = {}

local function safeArgs(query, parameters, cb, transaction)
	local queryType = type(query)

	if queryType == 'number' then
		query = queryStore[query]
		assert(query, "First argument received invalid query store reference")
	elseif transaction then
		if queryType ~= 'table' then
			error(("First argument expected table, received '%s'"):format(query))
		end
	elseif queryType ~= 'string' then
		error(("First argument expected string, received '%s'"):format(query))
	end

	if parameters then
		local paramType = type(parameters)

		if paramType ~= 'table' and paramType ~= 'function' then
			error(("Second argument expected table or function, received '%s'"):format(parameters))
		end

		if paramType == 'function' or parameters.__cfx_functionReference then
			cb = parameters
			parameters = nil
		end
	end

	if cb and parameters then
		local cbType = type(cb)

		if cbType ~= 'function' and (cbType == 'table' and not cb.__cfx_functionReference) then
			error(("Third argument expected function, received '%s'"):format(cb))
		end
	end

	return query, parameters, cb
end

local oxmysql = exports.oxmysql

local mysql_method_mt = {
	__call = function(self, query, parameters, cb)
		query, parameters, cb = safeArgs(query, parameters, cb, self.method == 'transaction')
		return oxmysql[self.method](nil, query, parameters, cb, resourceName, options.return_callback_errors)
	end
}

local MySQL = setmetatable(MySQL or {}, {
	__index = function(_, index)
		return function(...)
			return oxmysql[index](nil, ...)
		end
	end
})

for _, method in pairs({
	'scalar', 'single', 'query', 'insert', 'update', 'prepare', 'transaction', 'rawExecute',
}) do
	MySQL[method] = setmetatable({
		method = method,
		await = function(query, parameters)
			query, parameters = safeArgs(query, parameters, nil, method == 'transaction')
			return await(oxmysql[method], query, parameters)
		end
	}, mysql_method_mt)
end

local alias = {
	fetchAll = 'query',
	fetchScalar = 'scalar',
	fetchSingle = 'single',
	insert = 'insert',
	execute = 'update',
	transaction = 'transaction',
	prepare = 'prepare'
}

local alias_mt = {
	__index = function(self, key)
		if alias[key] then
			local method = MySQL[alias[key]]
			MySQL.Async[key] = method
			MySQL.Sync[key] = method.await
			alias[key] = nil
			return self[key]
		end
	end
}

local function addStore(query, cb)
	assert(type(query) == 'string', 'The SQL Query must be a string')

	local storeN = #queryStore + 1
	queryStore[storeN] = query

	return cb and cb(storeN) or storeN
end

MySQL.Sync = setmetatable({ store = addStore }, alias_mt)
MySQL.Async = setmetatable({ store = addStore }, alias_mt)

local function onReady(cb)
	while GetResourceState('oxmysql') ~= 'started' do
		Wait(50)
	end

	oxmysql.awaitConnection()

	return cb and cb() or true
end

MySQL.ready = setmetatable({
	await = onReady
}, {
	__call = function(_, cb)
		Citizen.CreateThreadNow(function() onReady(cb) end)
	end,
})

function MySQL.startTransaction(cb)
	return oxmysql:startTransaction(cb, resourceName)
end

local function builderRecord(value, fields, label)
	assert(type(value) == 'table' and getmetatable(value) == nil, 'queryBuilder: ' .. label .. ' must be a plain table')
	for key in pairs(value) do
		assert(fields[key], 'queryBuilder: unsupported ' .. label .. ' field')
	end
	return value
end

local function builderArray(value, label, map, allowEmpty)
	assert(type(value) == 'table' and getmetatable(value) == nil, 'queryBuilder: ' .. label .. ' must be a dense array')
	local length = #value
	local count = 0
	for key in pairs(value) do
		assert(type(key) == 'number' and key >= 1 and key <= length and key % 1 == 0, 'queryBuilder: ' .. label .. ' must be a dense array')
		count = count + 1
	end
	assert(count == length and (allowEmpty or length > 0), 'queryBuilder: ' .. label .. ' must be a dense array with the required elements')
	local result = {}
	for index = 1, length do
		result[index] = map(value[index])
	end
	return result
end

local function builderValue(value)
	local valueType = type(value)
	assert(valueType == 'string' or valueType == 'boolean' or
		(valueType == 'number' and value == value and value ~= math.huge and value ~= -math.huge),
		'queryBuilder: values must be non-null strings, booleans, or finite numbers')
	return value
end

local function identifierPart(part)
	assert(type(part) == 'string' and part:find('%S') and not part:find('[.*?%c]'),
		'queryBuilder: invalid identifier segment')
	return part
end

local function builderIdentifier(name)
	assert(type(name) == 'string' and #name > 0 and not name:find('^%.') and not name:find('%.$') and not name:find('%.%.'),
		'queryBuilder: expected a non-empty dot-separated identifier')
	local parts = {}
	for part in name:gmatch('[^.]+') do
		parts[#parts + 1] = identifierPart(part)
	end
	return { kind = 'identifier', parts = parts }
end

local function copyIdentifier(value)
	builderRecord(value, { kind = true, parts = true }, 'identifier')
	assert(value.kind == 'identifier', 'queryBuilder: expected identifier kind')
	return { kind = 'identifier', parts = builderArray(value.parts, 'identifier parts', identifierPart) }
end

local function copyPredicate(value, depth)
	depth = depth or 0
	assert(depth < 64, 'queryBuilder: predicate nesting exceeds 64 levels')
	builderRecord(value, { kind = true, operator = true, column = true, value = true, values = true, predicates = true }, 'predicate')
	if value.kind == 'comparison' then
		builderRecord(value, { kind = true, operator = true, column = true, value = true }, 'comparison')
		assert(value.operator == 'eq', 'queryBuilder: unsupported comparison operator')
		return { kind = 'comparison', operator = 'eq', column = copyIdentifier(value.column), value = builderValue(value.value) }
	elseif value.kind == 'collection' then
		builderRecord(value, { kind = true, operator = true, column = true, values = true }, 'collection')
		assert(value.operator == 'inArray', 'queryBuilder: unsupported collection operator')
		return { kind = 'collection', operator = 'inArray', column = copyIdentifier(value.column), values = builderArray(value.values, 'inArray values', builderValue, true) }
	elseif value.kind == 'group' then
		builderRecord(value, { kind = true, operator = true, predicates = true }, 'group')
		assert(value.operator == 'allOf', 'queryBuilder: unsupported group operator')
		return { kind = 'group', operator = 'allOf', predicates = builderArray(value.predicates, 'allOf predicates', function(child)
			return copyPredicate(child, depth + 1)
		end) }
	end

	error('queryBuilder: unsupported predicate kind')
end

MySQL.op = {
	eq = function(column, value)
		return { kind = 'comparison', operator = 'eq', column = builderIdentifier(column), value = builderValue(value) }
	end,
	inArray = function(column, values)
		return { kind = 'collection', operator = 'inArray', column = builderIdentifier(column), values = builderArray(values, 'inArray values', builderValue, true) }
	end,
	allOf = function(...)
		local predicates = { ... }
		assert(select('#', ...) == #predicates, 'queryBuilder: allOf requires non-nil predicates')
		return { kind = 'group', operator = 'allOf', predicates = builderArray(predicates, 'allOf predicates', copyPredicate) }
	end,
}

local builderStates = setmetatable({}, { __mode = 'k' })
local builderMethods = {}
local builderMt = {
	__index = function(_, key)
		assert(builderMethods[key], 'queryBuilder: unsupported builder method ' .. tostring(key))
		return builderMethods[key]
	end,
	__newindex = function() error('queryBuilder: builder state is immutable') end,
	__metatable = false,
}

local function newBuilder(spec)
	local builder = setmetatable({}, builderMt)
	builderStates[builder] = spec
	return builder
end

local function copyState(builder)
	local state = assert(builderStates[builder], 'queryBuilder: expected builder; use colon syntax for chain methods')
	local spec = {}
	for key, value in pairs(state) do spec[key] = value end
	return spec
end

function MySQL.table(name)
	return newBuilder({ kind = 'select', from = builderIdentifier(name), columns = '*' })
end

function builderMethods:select(columns)
	local spec = copyState(self)
	spec.columns = builderArray(columns, 'select columns', builderIdentifier)
	return newBuilder(spec)
end

function builderMethods:where(predicate)
	local spec = copyState(self)
	predicate = copyPredicate(predicate)
	if spec.where then
		local predicates = {}
		if spec.where.kind == 'group' then
			for index, child in ipairs(spec.where.predicates) do predicates[index] = child end
		else
			predicates[1] = spec.where
		end
		predicates[#predicates + 1] = predicate
		spec.where = { kind = 'group', operator = 'allOf', predicates = predicates }
	else
		spec.where = predicate
	end
	return newBuilder(spec)
end

function builderMethods:limit(limit)
	assert(type(limit) == 'number' and limit >= 0 and limit <= 9007199254740991 and limit % 1 == 0,
		'queryBuilder: limit must be a non-negative safe integer')
	local spec = copyState(self)
	spec.limit = limit
	return newBuilder(spec)
end

local function executeBuilder(builder, mode, cb)
	local spec = copyState(builder)
	spec.from = copyIdentifier(spec.from)
	if spec.columns ~= '*' then spec.columns = builderArray(spec.columns, 'select columns', copyIdentifier) end
	if spec.where then spec.where = copyPredicate(spec.where) end
	if mode == 'single' then spec.limit = math.min(spec.limit or 1, 1) end
	if cb ~= nil then
		assert(type(cb) == 'function' or (type(cb) == 'table' and cb.__cfx_functionReference), 'queryBuilder: callback must be a function')
		return oxmysql.queryBuilder(nil, spec, mode, cb, resourceName, options.return_callback_errors)
	end
	return await(oxmysql.queryBuilder, spec, mode)
end

function builderMethods:get(cb)
	return executeBuilder(self, 'query', cb)
end

function builderMethods:first(cb)
	return executeBuilder(self, 'single', cb)
end

_ENV.MySQL = MySQL

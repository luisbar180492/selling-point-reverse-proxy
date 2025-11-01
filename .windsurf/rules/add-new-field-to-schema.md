---
trigger: manual
---

# Adding New Field to Schema - Complete Workflow

## 1. Database Schema Updates
- **Update Prisma schema**: Modify `selling-point-api/selling-point-db/schema.prisma`
  - Add the new field to the appropriate model
  - Consider field type, constraints, defaults, and relationships
  - Add `@map()` if database column name differs from field name
  - Update `@@unique` constraints if needed

## 2. Database Migration & Generation
- **Generate Prisma client**: 
  ```bash
  cd selling-point-api && npx prisma generate --schema selling-point-db/schema.prisma
  ```
- **Create migration** (if needed for production):
  ```bash
  cd selling-point-api && npx prisma migrate dev --schema selling-point-db/schema.prisma
  ```

## 3. Backend API Updates
- **Update GraphQL schema**: Modify `selling-point-api/schema.gql`
  - Add field to relevant types/inputs
  - Consider nullable vs non-nullable based on requirements
- **Update GraphQL resolvers**: Check `selling-point-api/src/resolvers/`
  - Update query/mutation resolvers to handle new field
  - Add field resolvers if complex logic needed
- **Update validation**: Check `selling-point-api/src/common/validation/`
  - Add validation rules for new field
  - Update DTOs and validation pipes
- **Update services/business logic**:
  - Modify service methods to handle new field
  - Update create/update operations

## 4. Frontend Updates
- **Update GraphQL queries/mutations**: 
  - Add new field to relevant queries in frontend
  - Update mutation inputs to include new field
- **Update TypeScript types**:
  - Regenerate GraphQL types if using code generation
  - Update manual type definitions
- **Update UI components**:
  - Add form fields for input
  - Update display components to show new field
  - Handle validation and error states
- **Update state management**:
  - Update Redux/Zustand stores if applicable
  - Update local component state handling

## 5. Testing & Validation
- **Test database operations**: Verify CRUD operations work with new field
- **Test API endpoints**: Ensure GraphQL queries/mutations handle new field correctly
- **Test frontend integration**: Verify UI correctly displays and submits new field
- **Update unit/integration tests**: Add test cases for new field functionality

## 6. Documentation
- **Update API documentation**: Document new field in GraphQL schema docs
- **Update README**: Add notes about new field if significant
- **Update migration notes**: Document any breaking changes or special considerations